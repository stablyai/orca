import { Buffer } from 'node:buffer'
import type { Project } from '../../shared/types'
import type {
  IPtyProvider,
  PtyProcessInfo,
  PtyProviderBufferSnapshot,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/types'
import { herdrSessionNameForProject } from '../../shared/herdr-session-identity'
import type { HerdrProjectHostGraph } from './herdr-runtime-manager'
import { HerdrRuntimeManager } from './herdr-runtime-manager'
import {
  type HerdrHostTransport,
  type HerdrPane,
  type HerdrTerminalController,
  type HerdrTerminalFrame,
  unwrapHerdrResponse
} from './herdr-runtime-contract'

const HERDR_PTY_PREFIX = 'herdr:'

export type HerdrPtyIdentity = {
  hostId: string
  projectId: string
  worktreeId: string
  tabId: string
  leafId: string
}

export type HerdrPtyTarget = {
  project: Project
  graph: HerdrProjectHostGraph
  identity: HerdrPtyIdentity
}

export type HerdrPtyTargetResolver = (
  opts: PtySpawnOptions,
  persistedIdentity: HerdrPtyIdentity | null
) => Promise<HerdrPtyTarget | null>

type HerdrPtyBinding = {
  id: string
  sessionName: string
  paneId: string
  identity: HerdrPtyIdentity
  controller: HerdrTerminalController
  cwd: string
  cols: number
  rows: number
  sequenceChars: number
  snapshot: string
  detached: boolean
  unsubscribe: (() => void)[]
}

type PaneProcessInfo = {
  shell_pid?: number
  foreground_processes: { name: string; cwd?: string }[]
}

function encodePtyId(identity: HerdrPtyIdentity): string {
  return `${HERDR_PTY_PREFIX}${Buffer.from(JSON.stringify(identity), 'utf8').toString('base64url')}`
}

export function decodeHerdrPtyId(id: string): HerdrPtyIdentity | null {
  if (!id.startsWith(HERDR_PTY_PREFIX)) return null
  try {
    const value = JSON.parse(
      Buffer.from(id.slice(HERDR_PTY_PREFIX.length), 'base64url').toString()
    ) as Partial<HerdrPtyIdentity> | null
    if (
      !value ||
      typeof value.projectId !== 'string' ||
      typeof value.hostId !== 'string' ||
      typeof value.worktreeId !== 'string' ||
      typeof value.tabId !== 'string' ||
      typeof value.leafId !== 'string'
    ) {
      return null
    }
    return value as HerdrPtyIdentity
  } catch {
    return null
  }
}

function decodeFrame(frame: HerdrTerminalFrame): string {
  return Buffer.from(frame.bytes, 'base64').toString('utf8')
}

/**
 * Adapts Herdr's durable pane controller to Orca's existing PTY boundary.
 * Project terminal panes never fall back after they resolve to a Herdr target;
 * the fallback only owns non-project surfaces that have no project identity.
 */
export class HerdrPtyProvider implements IPtyProvider {
  private readonly manager: HerdrRuntimeManager
  private readonly bindings = new Map<string, HerdrPtyBinding>()
  private readonly dataListeners = new Set<
    (payload: { id: string; data: string; sequenceChars?: number }) => void
  >()
  private readonly replayListeners = new Set<(payload: { id: string; data: string }) => void>()
  private readonly exitListeners = new Set<(payload: { id: string; code: number }) => void>()
  private fallbackUnsubscribe: (() => void)[] = []

  constructor(
    private fallback: IPtyProvider,
    private readonly transport: HerdrHostTransport,
    private readonly resolveTarget: HerdrPtyTargetResolver
  ) {
    this.manager = new HerdrRuntimeManager(transport)
    this.subscribeToFallback()
  }

  replaceFallback(fallback: IPtyProvider): void {
    for (const unsubscribe of this.fallbackUnsubscribe.splice(0)) unsubscribe()
    this.fallback = fallback
    this.subscribeToFallback()
  }

  private subscribeToFallback(): void {
    this.fallbackUnsubscribe = [
      this.fallback.onData((payload) => this.emitData(payload)),
      this.fallback.onReplay((payload) => this.emitReplay(payload)),
      this.fallback.onExit((payload) => this.emitExit(payload))
    ]
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const persistedIdentity = opts.sessionId ? decodeHerdrPtyId(opts.sessionId) : null
    const target = await this.resolveTarget(opts, persistedIdentity)
    if (!target) return await this.fallback.spawn(opts)

    await this.manager.reconcileProjectHost(target.graph)
    const controller = await this.manager.controlProjectPane(
      target.project,
      target.identity.leafId,
      {
        cols: opts.cols,
        rows: opts.rows
      }
    )
    const id = encodePtyId(target.identity)
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
    if (this.bindings.has(id)) return
    const identity = decodeHerdrPtyId(id)
    if (!identity) return await this.fallback.attach(id)
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
    if (!target) throw new Error(`Cannot resolve persisted Herdr PTY ${id}`)
    await this.manager.reconcileProjectHost(target.graph)
    const controller = await this.manager.controlProjectPane(target.project, identity.leafId, {
      cols: 80,
      rows: 24
    })
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
    if (firstFrame) this.emitReplay({ id, data: firstFrame.data })
  }

  hasPty(id: string): boolean {
    return (
      this.bindings.has(id) ||
      (decodeHerdrPtyId(id) === null && (this.fallback.hasPty?.(id) ?? false))
    )
  }

  write(id: string, data: string): void {
    const binding = this.bindings.get(id)
    if (binding) binding.controller.write(data)
    else this.fallback.write(id, data)
  }

  resize(id: string, cols: number, rows: number): void {
    const binding = this.bindings.get(id)
    if (!binding) return this.fallback.resize(id, cols, rows)
    binding.cols = cols
    binding.rows = rows
    binding.controller.resize(cols, rows)
  }

  async shutdown(id: string, opts: { immediate?: boolean; keepHistory?: boolean }): Promise<void> {
    const binding = this.bindings.get(id)
    if (!binding) return await this.fallback.shutdown(id, opts)
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
    if (!binding) return await this.fallback.sendSignal(id, signal)
    const key = signal === 'SIGINT' ? 'ctrl+c' : signal === 'SIGQUIT' ? 'ctrl+\\' : null
    if (!key) throw new Error(`Herdr does not support signal ${signal}`)
    unwrapHerdrResponse(
      await this.transport.request(binding.sessionName, 'pane.send_keys', {
        pane_id: binding.paneId,
        keys: [key]
      })
    )
  }

  async getCwd(id: string): Promise<string> {
    const binding = this.bindings.get(id)
    if (!binding) return await this.fallback.getCwd(id)
    const pane = await this.getPane(binding)
    return pane.foreground_cwd ?? pane.cwd ?? binding.cwd
  }

  async getInitialCwd(id: string): Promise<string> {
    const binding = this.bindings.get(id)
    return binding ? binding.cwd : await this.fallback.getInitialCwd(id)
  }

  async clearBuffer(id: string): Promise<void> {
    if (!this.bindings.has(id)) await this.fallback.clearBuffer(id)
  }

  acknowledgeDataEvent(id: string, charCount: number): void {
    if (!this.bindings.has(id)) this.fallback.acknowledgeDataEvent(id, charCount)
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    const binding = this.bindings.get(id)
    if (!binding) return await this.fallback.hasChildProcesses(id)
    return (await this.getProcessInfo(binding)).foreground_processes.length > 0
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    const binding = this.bindings.get(id)
    if (!binding) return await this.fallback.getForegroundProcess(id)
    return (await this.getProcessInfo(binding)).foreground_processes.at(-1)?.name ?? null
  }

  async confirmForegroundProcess(id: string): Promise<string | null> {
    return await this.getForegroundProcess(id)
  }

  async serialize(ids: string[]): Promise<string> {
    const fallbackIds = ids.filter((id) => !this.bindings.has(id))
    return await this.fallback.serialize(fallbackIds)
  }

  async revive(state: string): Promise<void> {
    await this.fallback.revive(state)
  }

  async listProcesses(): Promise<PtyProcessInfo[]> {
    const fallback = await this.fallback.listProcesses()
    const herdr = await Promise.all(
      [...this.bindings.values()].map(async (binding) => {
        const pane = await this.getPane(binding)
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

  async getDefaultShell(): Promise<string> {
    return await this.fallback.getDefaultShell()
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    return await this.fallback.getProfiles()
  }

  async getAppliedSize(id: string): Promise<{ cols: number; rows: number } | null> {
    const binding = this.bindings.get(id)
    return binding
      ? { cols: binding.cols, rows: binding.rows }
      : ((await this.fallback.getAppliedSize?.(id)) ?? null)
  }

  async getBufferSnapshot(
    id: string,
    opts?: { scrollbackRows?: number }
  ): Promise<PtyProviderBufferSnapshot | null> {
    const binding = this.bindings.get(id)
    if (!binding) return (await this.fallback.getBufferSnapshot?.(id, opts)) ?? null
    return null
  }

  canProvideAuthoritativeBufferSnapshot(id: string): boolean {
    return this.bindings.has(id)
      ? false
      : (this.fallback.canProvideAuthoritativeBufferSnapshot?.(id) ?? false)
  }

  onData(
    callback: (payload: { id: string; data: string; sequenceChars?: number }) => void
  ): () => void {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  onReplay(callback: (payload: { id: string; data: string }) => void): () => void {
    this.replayListeners.add(callback)
    return () => this.replayListeners.delete(callback)
  }

  onExit(callback: (payload: { id: string; code: number }) => void): () => void {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }

  dispose(): void {
    for (const binding of this.bindings.values()) this.detachBinding(binding)
    this.manager.dispose()
    for (const unsubscribe of this.fallbackUnsubscribe) unsubscribe()
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
    if (!paneId) throw new Error(`Herdr pane is not reconciled: ${input.identity.leafId}`)
    const previous = this.bindings.get(input.id)
    if (previous) this.detachBinding(previous)
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

  private async waitForFirstFrame(
    binding: HerdrPtyBinding
  ): Promise<{ frame: HerdrTerminalFrame; data: string } | null> {
    return await new Promise((resolve, reject) => {
      let first = true
      const timeout = setTimeout(() => {
        first = false
        resolve(null)
      }, 2_000)
      binding.unsubscribe.push(
        binding.controller.onFrame((frame) => {
          const data = decodeFrame(frame)
          binding.cols = frame.width
          binding.rows = frame.height
          binding.snapshot = frame.full ? data : `${binding.snapshot}${data}`
          if (first) {
            first = false
            clearTimeout(timeout)
            resolve({ frame, data })
            return
          }
          binding.sequenceChars += data.length
          this.emitData({ id: binding.id, data, sequenceChars: binding.sequenceChars })
        }),
        binding.controller.onClosed(() => {
          if (binding.detached) return
          if (first) {
            first = false
            clearTimeout(timeout)
            this.detachBinding(binding)
            reject(new Error(`Herdr terminal controller closed before its first frame`))
            return
          }
          this.detachBinding(binding)
          this.emitExit({ id: binding.id, code: 0 })
        })
      )
    })
  }

  private detachBinding(binding: HerdrPtyBinding): void {
    if (binding.detached) return
    binding.detached = true
    for (const unsubscribe of binding.unsubscribe.splice(0)) unsubscribe()
    binding.controller.release()
    this.bindings.delete(binding.id)
  }

  private async getPane(binding: HerdrPtyBinding): Promise<
    HerdrPane & {
      cwd?: string
      foreground_cwd?: string
      label?: string
      title?: string
      terminal_title?: string
    }
  > {
    return unwrapHerdrResponse<{
      pane: HerdrPane & {
        cwd?: string
        foreground_cwd?: string
        label?: string
        title?: string
        terminal_title?: string
      }
    }>(await this.transport.request(binding.sessionName, 'pane.get', { pane_id: binding.paneId }))
      .pane
  }

  private async getProcessInfo(binding: HerdrPtyBinding): Promise<PaneProcessInfo> {
    return unwrapHerdrResponse<{ process_info: PaneProcessInfo }>(
      await this.transport.request(binding.sessionName, 'pane.process_info', {
        pane_id: binding.paneId
      })
    ).process_info
  }

  private emitData(payload: { id: string; data: string; sequenceChars?: number }): void {
    for (const listener of this.dataListeners) listener(payload)
  }

  private emitReplay(payload: { id: string; data: string }): void {
    for (const listener of this.replayListeners) listener(payload)
  }

  private emitExit(payload: { id: string; code: number }): void {
    for (const listener of this.exitListeners) listener(payload)
  }
}
