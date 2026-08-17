import type {
  IPtyProvider,
  PtyProcessInfo,
  PtyProviderBufferSnapshot,
  PtySpawnOptions,
  PtySpawnResult,
  PtyBackgroundStreamEvent,
  PtyDataEvent
} from '../../types'
import { randomUUID } from 'node:crypto'
import { herdrSessionNameForProject } from '../../../../shared/herdr-session-identity'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import { HerdrRuntimeError, unwrapHerdrResponse } from './herdr-runtime-contract'
import { decodeHerdrPtyId, encodeHerdrPtyId } from './herdr-pty-codec'
import type {
  HerdrPtyBinding,
  HerdrPtyIdentity,
  HerdrPtyTarget,
  HerdrPaneMoveDestination,
  HerdrPaneSwapOptions
} from './herdr-pty-types'
import { assertHerdrMigrationReady } from './herdr-pty-types'
import { clearHerdrBindingBuffer } from './herdr-pty-binding-queries'
import {
  bufferSnapshotForBinding,
  movePaneForBinding,
  notifyBlockedForBinding,
  resizePaneForBinding,
  swapPaneForBinding,
  zoomPaneForBinding
} from './herdr-pty-provider-pane-methods'
import {
  getHerdrForegroundProcess,
  getHerdrProcessInfo,
  herdrHasChildProcesses
} from './herdr-pty-provider-process'
import {
  createBinding,
  getRuntime,
  releaseBinding,
  awaitFirstFrame,
  disposeAll
} from './herdr-pty-provider-runtime'
import type { HerdrHostTransport } from './herdr-runtime-contract'
import type { HerdrRuntimeManager } from './herdr-runtime-manager'
export { decodeHerdrPtyId } from './herdr-pty-codec'
export type { HerdrPtyIdentity, HerdrPtyTarget } from './herdr-pty-types'

export type HerdrPtyTargetResolver = (
  opts: PtySpawnOptions,
  persistedIdentity: HerdrPtyIdentity | null
) => Promise<HerdrPtyTarget | null>

export class HerdrPtyProvider implements IPtyProvider {
  private readonly managers = new Map<string, HerdrRuntimeManager>()
  private readonly transportForTarget: (target: HerdrPtyTarget) => HerdrHostTransport
  private readonly resolveTarget: HerdrPtyTargetResolver
  private readonly bindings = new Map<string, HerdrPtyBinding>()
  private readonly sharedName?: () => string | undefined
  private readonly backgroundStreamListeners = new Set<
    (payload: PtyBackgroundStreamEvent) => void
  >()
  private readonly writeUnavailableListeners = new Set<(payload: { id: string }) => void>()
  private readonly dataListeners = new Set<(payload: PtyDataEvent) => void>()
  private readonly replayListeners = new Set<(payload: { id: string; data: string }) => void>()
  private readonly exitListeners = new Set<
    (payload: { id: string; code: number; incarnationId?: string }) => void
  >()

  constructor(
    transportForTarget: (target: HerdrPtyTarget) => HerdrHostTransport,
    resolveTarget: HerdrPtyTargetResolver,
    sharedName?: () => string | undefined
  ) {
    this.transportForTarget = transportForTarget
    this.resolveTarget = resolveTarget
    this.sharedName = sharedName
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const persistedIdentity = opts.sessionId ? decodeHerdrPtyId(opts.sessionId) : null
    const target = await this.resolveTarget(opts, persistedIdentity)
    if (!target) {
      throw new HerdrRuntimeError('target_not_found', 'Could not resolve herdr target for spawn')
    }
    await assertHerdrMigrationReady(target)

    const runtime = this.runtimeFor(target)
    await runtime.manager.reconcileProjectHost(target.graph)
    const sessionName = herdrSessionNameForProject(target.project, this.sharedName?.())
    let paneId = runtime.manager.getPaneId(
      sessionName,
      target.identity.projectId,
      target.identity.leafId
    )
    // Why: a leaf that reconciled without a pane must recreate the terminal
    // instead of failing the spawn (and the tab with it).
    if (!paneId) {
      const worktree = target.graph.worktrees[0]
      paneId = await runtime.manager.materializeLeafPane(
        target.project,
        target.identity.leafId,
        opts.cwd ?? '',
        worktree?.displayName ?? worktree?.path ?? ''
      )
    }
    const controller = await runtime.manager.controlProjectPane(
      target.project,
      target.identity.leafId,
      { cols: opts.cols, rows: opts.rows }
    )
    await target.activateHerdr?.()
    const resolvedPaneId =
      paneId ??
      runtime.manager.getPaneId(sessionName, target.identity.projectId, target.identity.leafId)
    // Why: an attach fence compares the encoded id against the persisted
    // owner. A stale identity whose pane no longer reconciles (e.g. a binding
    // from before pane tokens were persisted) must signal "gone" so the caller
    // retires the owner and falls back to a fresh spawn instead of failing the
    // fence forever.
    const staleAttach =
      opts.attachOnly === true &&
      persistedIdentity !== null &&
      (resolvedPaneId === null || resolvedPaneId !== persistedIdentity.paneId)
    if (!resolvedPaneId || staleAttach) {
      controller.release()
      if (staleAttach) {
        throw new SessionNotFoundError(opts.sessionId ?? '')
      }
      throw new Error(`Herdr pane is not reconciled: ${target.identity.leafId}`)
    }
    const identity: HerdrPtyIdentity = {
      ...target.identity,
      version: 2,
      paneId: resolvedPaneId
    }
    const id = encodeHerdrPtyId(identity)
    const incarnationId = opts.expectedIncarnationId ?? randomUUID()
    const binding = this.bindController({
      id,
      controller,
      transport: runtime.transport,
      identity,
      paneId: resolvedPaneId,
      sessionName,
      incarnationId,
      cwd: opts.cwd ?? '',
      cols: opts.cols,
      rows: opts.rows
    })
    const firstFrame = await this.waitForFirstFrame(binding)
    if (!opts.sessionId && opts.command) {
      controller.write(`${opts.command}\r`)
    }
    return {
      id,
      isReattach: !!opts.sessionId,
      ...(incarnationId ? { incarnationId } : {}),
      ...(firstFrame
        ? {
            snapshot: firstFrame.data,
            snapshotCols: firstFrame.frame.width,
            snapshotRows: firstFrame.frame.height
          }
        : {})
    }
  }

  async attach(id: string): Promise<Pick<PtySpawnResult, 'providerSequence'> | void> {
    if (this.bindings.has(id)) {
      return
    }
    const identity = decodeHerdrPtyId(id)
    if (!identity) {
      throw new Error(`Invalid herdr PTY ID: ${id}`)
    }

    const target = await this.resolveTarget(
      {
        cols: 80,
        rows: 24,
        sessionId: id,
        worktreeId: identity.worktreeId,
        tabId: identity.tabId,
        paneKey: `${identity.tabId}:${identity.leafId}`
      },
      identity
    )
    if (!target) {
      throw new Error(`Cannot resolve persisted Herdr PTY ${id}`)
    }
    await assertHerdrMigrationReady(target)
    const runtime = this.runtimeFor(target)
    await runtime.manager.reconcileProjectHost(target.graph)
    const controller = await runtime.manager.controlProjectPane(target.project, identity.leafId, {
      cols: 80,
      rows: 24
    })
    await target.activateHerdr?.()
    const sessionName = herdrSessionNameForProject(target.project, this.sharedName?.())
    const paneId =
      runtime.manager.getPaneId(sessionName, identity.projectId, identity.leafId) ?? identity.paneId
    if (!paneId) {
      controller.release()
      throw new Error(`Herdr pane is not reconciled: ${identity.leafId}`)
    }
    const binding = this.bindController({
      id,
      controller,
      transport: runtime.transport,
      identity,
      paneId,
      sessionName,
      incarnationId: randomUUID(),
      cwd: '',
      cols: 80,
      rows: 24
    })
    const firstFrame = await this.waitForFirstFrame(binding)
    if (firstFrame) {
      this.emitReplay({ id, data: firstFrame.data })
    }
  }

  async shutdown(id: string, opts: { immediate?: boolean; keepHistory?: boolean }): Promise<void> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return
    }
    if (opts.keepHistory) {
      this.detachBinding(binding)
      return
    }
    try {
      unwrapHerdrResponse(
        await binding.transport.request(binding.sessionName, 'pane.close', {
          pane_id: binding.paneId
        })
      )
    } catch {}
    this.detachBinding(binding)
    this.emitExit({ id, code: 0 })
  }

  write(id: string, data: string): void {
    const binding = this.bindings.get(id)
    if (!binding) {
      return
    }
    binding.controller.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const binding = this.bindings.get(id)
    if (!binding) {
      return
    }
    binding.controller.resize(cols, rows)
  }

  pauseProducer(_id: string): void {}

  resumeProducer(_id: string): void {}

  setPtyBackgrounded(_id: string, _background: boolean): void {}

  onBackgroundStreamEvent(callback: (payload: PtyBackgroundStreamEvent) => void): () => void {
    this.backgroundStreamListeners.add(callback)
    return () => this.backgroundStreamListeners.delete(callback)
  }

  onWriteUnavailable(callback: (payload: { id: string }) => void): () => void {
    this.writeUnavailableListeners.add(callback)
    return () => this.writeUnavailableListeners.delete(callback)
  }

  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return null
    }
    return null
  }

  async getCwd(id: string): Promise<string> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return ''
    }
    try {
      return unwrapHerdrResponse(
        await binding.transport.request<string>(binding.sessionName, 'pane.cwd', { pane_id: id })
      )
    } catch {
      return ''
    }
  }

  async getInitialCwd(id: string): Promise<string> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return ''
    }
    try {
      return unwrapHerdrResponse(
        await binding.transport.request<string>(binding.sessionName, 'pane.cwd', { pane_id: id })
      )
    } catch {
      return ''
    }
  }

  async clearBuffer(id: string): Promise<void> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return
    }
    await clearHerdrBindingBuffer(binding)
  }

  acknowledgeDataEvent(_id: string, _charCount: number): void {}

  async hasChildProcesses(id: string): Promise<boolean> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return false
    }
    return herdrHasChildProcesses(binding)
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return null
    }
    return getHerdrForegroundProcess(binding)
  }

  async listProcesses(): Promise<PtyProcessInfo[]> {
    const herdrResults = await Promise.allSettled(
      [...this.bindings.values()].map(getHerdrProcessInfo)
    )
    const herdr = herdrResults.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    return herdr
  }

  async getBufferSnapshot(
    id: string,
    opts?: { scrollbackRows?: number }
  ): Promise<PtyProviderBufferSnapshot | null> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return null
    }
    return bufferSnapshotForBinding(this.bindings, id, opts?.scrollbackRows)
  }

  async zoomPane(id: string, mode: 'toggle' | 'on' | 'off' = 'toggle') {
    return zoomPaneForBinding(this.bindings, id, mode)
  }

  async swapPane(id: string, params: HerdrPaneSwapOptions) {
    return swapPaneForBinding(this.bindings, id, params)
  }

  async movePane(id: string, destination: HerdrPaneMoveDestination, focus?: boolean) {
    return movePaneForBinding(this.bindings, id, destination, focus)
  }

  async resizePane(id: string, direction: 'left' | 'right' | 'up' | 'down', amount?: number) {
    return resizePaneForBinding(this.bindings, id, direction, amount)
  }

  async notifyBlocked(
    id: string,
    agent: string,
    state: 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
  ): Promise<void> {
    return notifyBlockedForBinding(this.bindings, id, agent, state)
  }

  canProvideAuthoritativeBufferSnapshot(id: string): boolean {
    return this.bindings.has(id)
  }

  async getDefaultShell(): Promise<string> {
    return 'bash'
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    return []
  }

  serialize(_ids: string[]): Promise<string> {
    return Promise.resolve('')
  }

  revive(_state: string): Promise<void> {
    return Promise.resolve()
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    const binding = this.bindings.get(id)
    if (!binding) {
      throw new Error(`Herdr PTY not found: ${id}`)
    }
    const key = signal === 'SIGINT' ? 'ctrl+c' : signal === 'SIGQUIT' ? 'ctrl+\\' : null
    if (!key) {
      throw new Error(`Herdr does not support signal ${signal}`)
    }
    unwrapHerdrResponse(
      await binding.transport.request(binding.sessionName, 'pane.send_keys', {
        pane_id: id,
        keys: [key]
      })
    )
  }

  onData(callback: (payload: PtyDataEvent) => void): () => void {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  onReplay(callback: (payload: { id: string; data: string }) => void): () => void {
    this.replayListeners.add(callback)
    return () => this.replayListeners.delete(callback)
  }

  onExit(
    callback: (payload: { id: string; code: number; incarnationId?: string }) => void
  ): () => void {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }

  private runtimeFor(target: HerdrPtyTarget) {
    return getRuntime(target, this.managers, this.transportForTarget, this.sharedName)
  }

  private bindController(
    input: Omit<HerdrPtyBinding, 'sequenceChars' | 'snapshot' | 'detached' | 'unsubscribe'>
  ): HerdrPtyBinding {
    return createBinding(input, this.bindings)
  }

  private async waitForFirstFrame(binding: HerdrPtyBinding) {
    return awaitFirstFrame(
      binding,
      (payload) => this.emitData(payload),
      (payload) => this.emitExit(payload),
      () => releaseBinding(binding, this.bindings)
    )
  }

  private detachBinding(binding: HerdrPtyBinding): void {
    releaseBinding(binding, this.bindings)
  }

  private emitData(payload: PtyDataEvent): void {
    for (const listener of this.dataListeners) {
      listener(payload)
    }
  }

  private emitExit(payload: { id: string; code: number; incarnationId?: string }): void {
    const incarnationId = payload.incarnationId ?? this.bindings.get(payload.id)?.incarnationId
    const event = incarnationId ? { ...payload, incarnationId } : payload
    for (const listener of this.exitListeners) {
      listener(event)
    }
  }

  private emitReplay(payload: { id: string; data: string }): void {
    for (const listener of this.replayListeners) {
      listener(payload)
    }
  }

  advanceGeneration(): number {
    return 0
  }

  killOrphanedPtys(_generation: number): void {}

  killAll(): void {
    for (const [, binding] of this.bindings) {
      binding.transport
        .request(binding.sessionName, 'pane.close', { pane_id: binding.paneId })
        .catch(() => {})
    }
    this.bindings.clear()
  }

  dispose(): void {
    disposeAll(this.bindings, this.managers, () => {
      for (const binding of this.bindings.values()) {
        binding.transport.disconnect?.()
      }
    })
  }

  replaceFallback(_fallback: IPtyProvider): void {}
}
