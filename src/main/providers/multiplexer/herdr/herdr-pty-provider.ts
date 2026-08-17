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
import { decodeHerdrPtyId, encodeHerdrPtyId } from './herdr-pty-types'
import type {
  HerdrPtyBinding,
  HerdrPtyIdentity,
  HerdrPtyTarget,
  HerdrPaneMoveDestination,
  HerdrPaneSwapOptions
} from './herdr-pty-types'
import { assertHerdrMigrationReady } from './herdr-pty-types'
import {
  clearHerdrBindingBuffer,
  getHerdrBindingBufferSnapshot,
  getHerdrBindingCwd,
  getHerdrBindingForegroundProcess,
  getHerdrBindingProcessInfo,
  herdrBindingHasChildProcesses,
  maybeNotifyBlocked,
  moveHerdrBinding,
  resizeHerdrBinding,
  swapHerdrBinding,
  zoomHerdrBinding
} from './herdr-pty-binding-queries'
import type { TerminalLogicalInput } from '../../../../shared/terminal-logical-key'
import { terminalLogicalInputFromBytes } from '../../../../shared/terminal-logical-key'
import {
  createBinding,
  getRuntime,
  releaseBinding,
  awaitFirstFrame,
  disposeAll,
  retireMissingHerdrPanes,
  emitHerdrPtyData,
  emitHerdrPtyExit,
  emitHerdrPtyReplay,
  killAllHerdrBindings,
  attachHerdrPty
} from './herdr-pty-provider-runtime'
import type { HerdrHostTransport } from './herdr-runtime-contract'
import type { HerdrRuntimeManager, HerdrSurfaceSync } from './herdr-runtime-manager'
import { startHerdrAgentIfRequested } from './herdr-pty-provider-runtime'
export { decodeHerdrPtyId } from './herdr-pty-types'
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
    sharedName?: () => string | undefined,
    private readonly surfaceSync?: HerdrSurfaceSync
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
    await startHerdrAgentIfRequested({
      sessionId: opts.sessionId,
      launchAgent: opts.launchAgent,
      command: opts.command,
      sessionName,
      leafId: target.identity.leafId,
      paneId: resolvedPaneId,
      request: async (name, method, params) =>
        unwrapHerdrResponse(await runtime.transport.request(name, method, params)),
      writeCommand: (text) => controller.write(text)
    })
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
    return attachHerdrPty({
      id,
      bindings: this.bindings,
      resolveTarget: this.resolveTarget,
      runtimeFor: (target) => this.runtimeFor(target),
      sharedName: this.sharedName,
      bind: (input) => this.bindController(input),
      waitForFirstFrame: (binding) => this.waitForFirstFrame(binding),
      emitReplay: (payload) => this.emitReplay(payload)
    })
  }

  async shutdown(id: string, opts: { immediate?: boolean; keepHistory?: boolean }): Promise<void> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return
    }
    if (opts.keepHistory) {
      releaseBinding(binding, this.bindings)
      return
    }
    try {
      unwrapHerdrResponse(
        await binding.transport.request(binding.sessionName, 'pane.close', {
          pane_id: binding.paneId
        })
      )
    } catch {}
    releaseBinding(binding, this.bindings)
    this.emitExit({ id, code: 0 })
  }

  write(id: string, data: string): void {
    this.writeLogical(id, terminalLogicalInputFromBytes(data))
  }

  writeLogical(id: string, input: TerminalLogicalInput): void {
    const binding = this.bindings.get(id)
    if (!binding) {
      return
    }
    if (input.kind === 'key') {
      void binding.transport
        .request(binding.sessionName, 'pane.send_keys', {
          pane_id: binding.paneId,
          keys: [input.name]
        })
        .catch(() => undefined)
      return
    }
    binding.controller.write(input.data)
  }

  resize(id: string, cols: number, rows: number): void {
    const binding = this.bindings.get(id)
    if (!binding) {
      return
    }
    binding.cols = cols
    binding.rows = rows
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
    return { cols: binding.cols, rows: binding.rows }
  }

  async getCwd(id: string): Promise<string> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return ''
    }
    try {
      return await getHerdrBindingCwd(binding)
    } catch {
      return binding.cwd
    }
  }

  async getInitialCwd(id: string): Promise<string> {
    return this.getCwd(id)
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
    return herdrBindingHasChildProcesses(binding)
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return null
    }
    return getHerdrBindingForegroundProcess(binding)
  }

  async listProcesses(): Promise<PtyProcessInfo[]> {
    const herdrResults = await Promise.allSettled(
      [...this.bindings.values()].map(getHerdrBindingProcessInfo)
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
    return getHerdrBindingBufferSnapshot(binding, opts?.scrollbackRows)
  }

  async zoomPane(id: string, mode: 'toggle' | 'on' | 'off' = 'toggle') {
    const binding = this.bindings.get(id)
    return binding ? zoomHerdrBinding(binding, mode) : null
  }

  async swapPane(id: string, params: HerdrPaneSwapOptions) {
    const binding = this.bindings.get(id)
    return binding ? swapHerdrBinding(binding, params) : null
  }

  async movePane(id: string, destination: HerdrPaneMoveDestination, focus?: boolean) {
    const binding = this.bindings.get(id)
    return binding ? moveHerdrBinding(binding, { destination, focus }) : null
  }

  async resizePane(id: string, direction: 'left' | 'right' | 'up' | 'down', amount?: number) {
    const binding = this.bindings.get(id)
    return binding ? resizeHerdrBinding(binding, direction, amount) : null
  }

  async notifyBlocked(
    id: string,
    agent: string,
    state: 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
  ): Promise<void> {
    const binding = this.bindings.get(id)
    if (binding) {
      await maybeNotifyBlocked(binding, agent, state)
    }
  }

  canProvideAuthoritativeBufferSnapshot(id: string): boolean {
    return this.bindings.has(id)
  }

  async getDefaultShell(): Promise<string> {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'cmd.exe'
    }
    return process.env.SHELL || '/bin/bash'
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
        pane_id: binding.paneId,
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
    return getRuntime(
      target,
      this.managers,
      this.transportForTarget,
      this.sharedName,
      this.livePaneListener,
      this.surfaceSync
    )
  }

  private readonly livePaneListener = (sessionName: string, livePaneIds: ReadonlySet<string>) => {
    retireMissingHerdrPanes(this.bindings, sessionName, livePaneIds, (binding) => {
      releaseBinding(binding, this.bindings)
      this.emitExit({ id: binding.id, code: 0 })
    })
  }

  private bindController(
    input: Omit<HerdrPtyBinding, 'sequenceChars' | 'snapshot' | 'detached' | 'unsubscribe'>
  ): HerdrPtyBinding {
    return createBinding(input, this.bindings)
  }

  private waitForFirstFrame(binding: HerdrPtyBinding) {
    return awaitFirstFrame(
      binding,
      (payload) => this.emitData(payload),
      (payload) => this.emitExit(payload),
      () => releaseBinding(binding, this.bindings)
    )
  }

  private emitData(payload: PtyDataEvent): void {
    emitHerdrPtyData(this.dataListeners, payload)
  }

  private emitExit(payload: { id: string; code: number; incarnationId?: string }): void {
    emitHerdrPtyExit(this.exitListeners, this.bindings, payload)
  }

  private emitReplay(payload: { id: string; data: string }): void {
    emitHerdrPtyReplay(this.replayListeners, payload)
  }

  advanceGeneration(): number {
    return 0
  }

  killOrphanedPtys(_generation: number): void {}

  killAll(): void {
    killAllHerdrBindings(this.bindings)
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
