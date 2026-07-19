import type {
  IPtyProvider,
  PtyProcessInfo,
  PtyProviderBufferSnapshot,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/types'
import { herdrSessionNameForProject } from '../../shared/herdr-session-identity'
import { HerdrRuntimeManager } from './herdr-runtime-manager'
import { type HerdrHostTransport, unwrapHerdrResponse } from './herdr-runtime-contract'
import { decodeHerdrPtyId, encodeHerdrPtyId, waitForFirstHerdrFrame } from './herdr-pty-codec'
import { HerdrPtyProviderBase } from './herdr-pty-provider-base'
export { decodeHerdrPtyId } from './herdr-pty-codec'
import type { HerdrPtyBinding, HerdrPtyIdentity, HerdrPtyTarget } from './herdr-pty-types'
import { getHerdrPane, getHerdrProcessInfo } from './herdr-pty-queries'
import { assertHerdrMigrationReady } from './herdr-pty-types'
export { findLegacyMigrationBlockers } from './herdr-pty-types'
export type { HerdrPtyIdentity, HerdrPtyTarget } from './herdr-pty-types'

export type HerdrPtyTargetResolver = (
  opts: PtySpawnOptions,
  persistedIdentity: HerdrPtyIdentity | null
) => Promise<HerdrPtyTarget | null>

export class HerdrPtyProvider extends HerdrPtyProviderBase implements IPtyProvider {
  private readonly manager: HerdrRuntimeManager
  constructor(
    fallback: IPtyProvider,
    private readonly transport: HerdrHostTransport,
    private readonly resolveTarget: HerdrPtyTargetResolver
  ) {
    super(fallback)
    this.manager = new HerdrRuntimeManager(transport)
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const persistedIdentity = opts.sessionId ? decodeHerdrPtyId(opts.sessionId) : null
    const target = await this.resolveTarget(opts, persistedIdentity)
    if (!target) {
      return await this.fallback.spawn(opts)
    }
    await assertHerdrMigrationReady(this.fallback, target)

    await this.manager.reconcileProjectHost(target.graph)
    const controller = await this.manager.controlProjectPane(
      target.project,
      target.identity.leafId,
      {
        cols: opts.cols,
        rows: opts.rows
      }
    )
    await target.activateHerdr?.()
    const id = encodeHerdrPtyId(target.identity)
    const binding = this.bindController({
      id,
      controller,
      identity: target.identity,
      sessionName: herdrSessionNameForProject(target.project),
      cwd: opts.cwd ?? '',
      cols: opts.cols,
      rows: opts.rows
    })
    const firstFrame = await this.waitForFirstFrame(binding)
    if (!persistedIdentity && opts.command) {
      controller.write(`${opts.command}\r`)
    }
    return {
      id,
      isReattach: persistedIdentity !== null,
      ...(firstFrame
        ? {
            snapshot: firstFrame.data,
            snapshotCols: firstFrame.frame.width,
            snapshotRows: firstFrame.frame.height
          }
        : {})
    }
  }

  async attach(id: string): Promise<void> {
    if (this.bindings.has(id)) {
      return
    }
    const identity = decodeHerdrPtyId(id)
    if (!identity) {
      return await this.fallback.attach(id)
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
    await assertHerdrMigrationReady(this.fallback, target)
    await this.manager.reconcileProjectHost(target.graph)
    const controller = await this.manager.controlProjectPane(target.project, identity.leafId, {
      cols: 80,
      rows: 24
    })
    await target.activateHerdr?.()
    const binding = this.bindController({
      id,
      controller,
      identity,
      sessionName: herdrSessionNameForProject(target.project),
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
      return await this.fallback.shutdown(id, opts)
    }
    if (opts.keepHistory) {
      this.detachBinding(binding)
      return
    }
    unwrapHerdrResponse(
      await this.transport.request(binding.sessionName, 'pane.close', {
        pane_id: binding.paneId
      })
    )
    this.detachBinding(binding)
    this.emitExit({ id, code: 0 })
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return await this.fallback.sendSignal(id, signal)
    }
    const key = signal === 'SIGINT' ? 'ctrl+c' : signal === 'SIGQUIT' ? 'ctrl+\\' : null
    if (!key) {
      throw new Error(`Herdr does not support signal ${signal}`)
    }
    unwrapHerdrResponse(
      await this.transport.request(binding.sessionName, 'pane.send_keys', {
        pane_id: binding.paneId,
        keys: [key]
      })
    )
  }

  async getCwd(id: string): Promise<string> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return await this.fallback.getCwd(id)
    }
    const pane = await getHerdrPane(this.transport, binding)
    return pane.foreground_cwd ?? pane.cwd ?? binding.cwd
  }

  async clearBuffer(id: string): Promise<void> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return await this.fallback.clearBuffer(id)
    }
    unwrapHerdrResponse(
      await this.transport.request(binding.sessionName, 'pane.send_keys', {
        pane_id: binding.paneId,
        keys: ['ctrl+l']
      })
    )
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return await this.fallback.hasChildProcesses(id)
    }
    return (await getHerdrProcessInfo(this.transport, binding)).foreground_processes.length > 0
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return await this.fallback.getForegroundProcess(id)
    }
    return (
      (await getHerdrProcessInfo(this.transport, binding)).foreground_processes.at(-1)?.name ?? null
    )
  }

  async confirmForegroundProcess(id: string): Promise<string | null> {
    return await this.getForegroundProcess(id)
  }

  async listProcesses(): Promise<PtyProcessInfo[]> {
    const fallback = await this.fallback.listProcesses()
    const herdr = await Promise.all(
      [...this.bindings.values()].map(async (binding) => {
        const pane = await getHerdrPane(this.transport, binding)
        return {
          id: binding.id,
          cwd: pane.foreground_cwd ?? pane.cwd ?? binding.cwd,
          title: pane.title ?? pane.terminal_title ?? pane.label ?? 'Herdr',
          worktreeId: binding.identity.worktreeId
        }
      })
    )
    return [...fallback, ...herdr]
  }

  async getBufferSnapshot(
    id: string,
    opts?: { scrollbackRows?: number }
  ): Promise<PtyProviderBufferSnapshot | null> {
    const binding = this.bindings.get(id)
    if (!binding) {
      return (await this.fallback.getBufferSnapshot?.(id, opts)) ?? null
    }
    const result = unwrapHerdrResponse<{
      read: { text: string; revision: number; truncated: boolean }
    }>(
      await this.transport.request(binding.sessionName, 'pane.read', {
        pane_id: binding.paneId,
        source: 'recent',
        lines: opts?.scrollbackRows,
        format: 'ansi',
        strip_ansi: false
      })
    )
    return {
      data: result.read.text,
      cols: binding.cols,
      rows: binding.rows,
      cwd: binding.cwd,
      seq: result.read.revision,
      source: 'headless'
    }
  }

  canProvideAuthoritativeBufferSnapshot(id: string): boolean {
    return this.bindings.has(id)
      ? true
      : (this.fallback.canProvideAuthoritativeBufferSnapshot?.(id) ?? false)
  }

  dispose(): void {
    for (const binding of this.bindings.values()) {
      this.detachBinding(binding)
    }
    this.manager.dispose()
    this.disposeBase()
  }

  private bindController(
    input: Omit<
      HerdrPtyBinding,
      'paneId' | 'sequenceChars' | 'snapshot' | 'detached' | 'unsubscribe'
    >
  ): HerdrPtyBinding {
    const paneId = this.manager.getPaneId(
      input.sessionName,
      input.identity.projectId,
      input.identity.leafId
    )
    if (!paneId) {
      throw new Error(`Herdr pane is not reconciled: ${input.identity.leafId}`)
    }
    const previous = this.bindings.get(input.id)
    if (previous) {
      this.detachBinding(previous)
    }
    const binding: HerdrPtyBinding = {
      ...input,
      paneId,
      sequenceChars: 0,
      snapshot: '',
      detached: false,
      unsubscribe: []
    }
    this.bindings.set(input.id, binding)
    return binding
  }

  private async waitForFirstFrame(binding: HerdrPtyBinding) {
    return waitForFirstHerdrFrame(binding, {
      emitData: (payload) => this.emitData(payload),
      emitExit: (payload) => this.emitExit(payload),
      detach: () => this.detachBinding(binding)
    })
  }

  private detachBinding(binding: HerdrPtyBinding): void {
    if (binding.detached) {
      return
    }
    binding.detached = true
    for (const unsubscribe of binding.unsubscribe.splice(0)) {
      unsubscribe()
    }
    binding.controller.release()
    this.bindings.delete(binding.id)
  }
}
