import { join } from 'node:path'
import type * as Wire from '../../preload/api/debug-api'
import { describeDebugAdapters } from './dap-adapter-registry'
import { Batcher } from './dap-protocol'
import { DebugBreakpointStore } from './debug-breakpoint-store'
import type { DebugSession } from './debug-session'
import { breakpointWire, buildDebugSnapshot, ScopedBreakpoints } from './debug-session-breakpoints'
import * as trust from './debug-service-trust'

export { DebugServiceError, DebugUnavailableError } from './debug-service-trust'
export type { DebugOrigin, DebugStartInput, HumanConfirmation } from './debug-service-trust'

// Why poll: DebugSession exposes its output ring and breakpoint answers, but no event for either.
const SYNC_INTERVAL_MS = 100
const OUTPUT_FLUSH_MS = 50
const NORMAL_END_REASONS = new Set(['stopped', 'the program terminated'])

export type DebugServiceConfig = trust.DebugTrustDeps & {
  userDataPath: string
  /** How long a finished session's output is kept; default 60 s. */
  outputRetentionMs?: number
}
type Target = Wire.DebugWorktree
type Origin = trust.DebugOrigin
type Fields = Wire.DebugBreakpointFields
type Snapshot = Wire.DebugSnapshot
type Output = Wire.DebugOutputEvent
type Event = Output | Wire.DebugStateEvent
type Status = Wire.DebugStatus
type Ready = { deps: DebugServiceConfig; breakpoints: ScopedBreakpoints; off: () => void }
type WorktreeDebug = trust.WorktreeDebug

/** One debug session per worktree root; the IPC handlers and CLI RPC share this instance. */
export class DebugService {
  private ctx: Ready | null = null
  private seq = 0
  private readonly entries = new Map<string, WorktreeDebug>()
  private readonly stateListeners = new Set<(snapshot: Snapshot) => void>()
  private readonly outputs = new Batcher<Output>(OUTPUT_FLUSH_MS)
  private readonly wires = (entry: WorktreeDebug) => this.ready().breakpoints.wires(entry)

  configure(deps: DebugServiceConfig): void {
    this.ctx?.off()
    const filePath = join(deps.userDataPath, 'debug-breakpoints.json')
    const store = new DebugBreakpointStore({ filePath })
    const off = store.onChange((root) => this.bump(this.entry(root)))
    this.ctx = { deps, breakpoints: new ScopedBreakpoints(store), off }
  }

  /** Stops every session and returns the service to unconfigured. */
  async dispose(): Promise<void> {
    const entries = [...this.entries.values()]
    entries.forEach((entry) => this.setTimer(entry, false))
    entries.forEach((entry) => entry.release && clearTimeout(entry.release))
    this.entries.clear()
    this.ctx?.off()
    this.ctx = null
    await Promise.allSettled(entries.map((entry) => entry.session?.dispose() ?? Promise.resolve()))
  }

  /** App quit: SIGKILL every adapter process group now; Electron never awaits an async dispose. */
  killAllSync(): void {
    this.entries.forEach((entry) => entry.session?.killSync())
  }

  onState(listener: (snapshot: Snapshot) => void): () => void {
    this.ready()
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Output arrives in batches, at most one per 50 ms. */
  onOutput(listener: (events: Output[]) => void): () => void {
    this.ready()
    this.outputs.listeners.add(listener)
    return () => this.outputs.listeners.delete(listener)
  }

  async describeAdapters(target?: Target): ReturnType<typeof describeDebugAdapters> {
    const { deps } = this.ready()
    const worktreePath = target ? (await this.trusted(target)).root : undefined
    return describeDebugAdapters({ settings: deps.getSettings(), worktreePath })
  }

  listConfigs(repoId: string, worktreePath: string) {
    return trust.listTrustedConfigs(this.ready().deps, repoId, worktreePath)
  }

  previewLaunch(target: Wire.DebugLaunchTarget) {
    return trust.previewTrustedLaunch(this.ready().deps, target)
  }

  /** Stores trust only with a HumanConfirmation, which only Orca's own window can produce. */
  approveLaunch(
    target: Wire.DebugLaunchTarget & { expectedHash: string },
    confirmation: trust.HumanConfirmation | undefined
  ) {
    return trust.approveTrustedLaunch(this.ready().deps, target, confirmation)
  }

  async start(input: trust.DebugStartInput): Promise<Wire.DebugResult<Snapshot>> {
    const launch = await trust.gateLaunch(this.ready().deps, input, input.origin)
    if (!launch.ok) {
      return launch
    }
    // Synchronous from here to the new session, so two concurrent starts cannot both pass.
    const entry = this.entry(launch.root)
    if (entry.live) {
      return trust.refuse('already-debugging', `Already debugging ${launch.root}`)
    }
    void entry.session?.dispose()
    const { store } = this.ready().breakpoints
    store.setAudience(launch.root, input.origin)
    const session = trust.createTrustedSession(launch, store, entry.exceptionFilters)
    if (entry.release) {
      clearTimeout(entry.release)
    }
    Object.assign(entry, { session, launch, origin: input.origin, lastError: null, threads: [] })
    const cliControlSeq = input.origin === 'cli' ? entry.seq : entry.cliControlSeq
    Object.assign(entry, { outputTotal: 0, release: null, cliControlSeq })
    session.onStateChange(() => this.onSessionState(entry, session))
    this.setTimer(entry, true)
    this.bump(entry)
    return this.settle(entry, session.start())
  }

  /** A cli caller may not stop a session a person started. */
  async stop(target: Target, origin: Origin = 'ui'): Promise<Wire.DebugResult<Snapshot>> {
    const entry = await this.trusted(target)
    return this.settle(entry, entry.requireSession(true, origin).stop())
  }

  async restart(target: Target, origin: Origin): Promise<Wire.DebugResult<Snapshot>> {
    const entry = await this.trusted(target)
    const session = entry.requireSession(false, origin)
    const refused = trust.restartRefusal(this.ready().deps.getSettings(), entry.launch)
    if (refused) {
      return refused
    }
    this.setTimer(entry, true)
    entry.cliControlSeq = origin === 'cli' ? entry.seq : entry.cliControlSeq
    return this.settle(entry, session.restart())
  }

  /** Stack, scopes and variables of the live session: open to every origin. */
  async inspect(target: Target): Promise<trust.DebugSessionReader> {
    const s = (await this.trusted(target)).requireSession(true)
    return {
      threads: () => s.threads(),
      stackTrace: (...args) => s.stackTrace(...args),
      scopes: (frameId) => s.scopes(frameId),
      variables: (...args) => s.variables(...args)
    }
  }

  /** Stepping, evaluate and setVariable: never for a cli caller in a session a person started. */
  async control(target: Target, origin: Origin): Promise<DebugSession> {
    return (await this.trusted(target)).requireSession(true, origin)
  }

  /** A cli continue, step or pause: the seq its wait counts from. Sync, so call it just before the request. */
  markCliControl(session: DebugSession): number {
    const entry = [...this.entries.values()].find((e) => e.session === session)
    return entry ? (entry.cliControlSeq = entry.seq) : this.seq
  }

  /** The seq of the last cli start, restart, continue, step or pause in this worktree. */
  async cliControlSeq(target: Target): Promise<number | null> {
    return (await this.trusted(target)).cliControlSeq
  }

  async setExceptionFilters(target: Target, filters: string[]): Promise<Snapshot> {
    const entry = await this.trusted(target)
    entry.exceptionFilters = [...filters]
    await (entry.live ? entry.session?.setExceptionFilters(filters) : undefined)
    this.bump(entry)
    return this.buildSnapshot(entry)
  }

  async addBreakpoint(target: Target, path: string, fields: Fields & { line: number }, o: Origin) {
    const entry = await this.trusted(target)
    entry.allowCodeFields(fields, o)
    const { file, bp } = this.ready().breakpoints.add(entry.root, path, fields, o)
    return breakpointWire(entry.session, file, bp, entry.origin)
  }

  async updateBreakpoint(target: Target, id: string, fields: Fields, origin: Origin) {
    const entry = await this.trusted(target)
    entry.allowCodeFields(fields, origin)
    const { file, bp } = this.ready().breakpoints.update(entry.root, id, fields, origin)
    return breakpointWire(entry.session, file, bp, entry.origin)
  }

  async removeBreakpoint(target: Target, id: string, origin: Origin = 'ui'): Promise<void> {
    this.ready().breakpoints.remove((await this.trusted(target)).root, id, origin)
  }

  async setFileLines(target: Target, path: string, lines: readonly { id: string; line: number }[]) {
    const entry = await this.trusted(target)
    const file = this.ready().breakpoints.setFileLines(entry.root, path, lines)
    return this.wires(entry).filter((bp) => bp.path === file)
  }

  async listBreakpoints(target: Target): Promise<Wire.DebugBreakpointWire[]> {
    return this.wires(await this.trusted(target))
  }

  async snapshot(target: Target): Promise<Snapshot> {
    const entry = await this.trusted(target)
    this.sync(entry)
    return this.buildSnapshot(entry)
  }

  async eventsSince(target: Target, since: number): Promise<Wire.DebugEventsPage> {
    const entry = await this.trusted(target)
    this.sync(entry)
    const events = entry.ring.all().filter((event) => event.seq > since)
    return { events, latestSeq: entry.seq, truncated: since < entry.evictedThrough }
  }

  /** Resolves on a state in `statuses` after sinceSeq (else the NEXT one), or timedOut after timeoutMs. */
  async waitFor(target: Target, statuses: readonly Status[], timeoutMs: number, sinceSeq?: number) {
    const entry = await this.trusted(target)
    entry.requireSession(false)
    if (sinceSeq !== undefined && entry.reachedSince(sinceSeq, statuses)) {
      return { timedOut: false, snapshot: this.buildSnapshot(entry) }
    }
    return new Promise<{ timedOut: boolean; snapshot: Snapshot }>((resolve) => {
      const finish = (timedOut: boolean): void => {
        clearTimeout(timer)
        entry.waiters.delete(waiter)
        resolve({ timedOut, snapshot: this.buildSnapshot(entry) })
      }
      const waiter = { statuses, finish }
      const timer = setTimeout(() => finish(true), timeoutMs)
      entry.waiters.add(waiter)
    })
  }

  private ready(): Ready {
    if (!this.ctx) {
      throw new trust.DebugUnavailableError()
    }
    return this.ctx
  }

  /** Every channel re-derives the root from the repo in main; a bare caller path is never trusted. */
  private async trusted(target: Target): Promise<WorktreeDebug> {
    const { repoId, worktreePath } = target
    const resolved = await trust.resolveTrustedRoot(this.ready().deps, repoId, worktreePath, false)
    if (!resolved.ok) {
      throw new trust.DebugServiceError(resolved.reason, resolved.message)
    }
    return this.entry(resolved.root)
  }

  private entry(root: string): WorktreeDebug {
    const entry = this.entries.get(root) ?? new trust.WorktreeDebug(root)
    this.entries.set(root, entry)
    return entry
  }

  private async settle(entry: WorktreeDebug, work: Promise<void>) {
    try {
      await work
    } catch (error) {
      return trust.refuse('request-failed', error instanceof Error ? error.message : String(error))
    }
    return { ok: true as const, value: this.buildSnapshot(entry) }
  }

  private setTimer(entry: WorktreeDebug, on: boolean): void {
    if (entry.timer && !on) {
      clearInterval(entry.timer)
      entry.timer = null
    } else if (!entry.timer && on) {
      entry.timer = setInterval(() => this.sync(entry), SYNC_INTERVAL_MS)
      entry.timer.unref?.()
    }
  }

  private onSessionState(entry: WorktreeDebug, session: DebugSession): void {
    // After dispose the service is unconfigured; a terminating session has nothing left to report.
    if (entry.session !== session || !this.ctx) {
      return
    }
    const { status, reason } = session.state
    if (status === 'failed' || (reason && !NORMAL_END_REASONS.has(reason))) {
      entry.lastError = reason ?? null
    }
    if (status === 'stopped') {
      const keep = (threads: Wire.DebugThreadWire[]): void => {
        if (entry.session === session && session.state.status === 'stopped') {
          entry.threads = threads.map(({ id, name }) => ({ id, name }))
          this.bump(entry)
        }
      }
      session.threads().then(keep, () => {})
    }
    this.sync(entry)
    if (!entry.live) {
      entry.threads = []
      this.setTimer(entry, false)
      this.scheduleRelease(entry, session)
    }
    this.bump(entry)
    ;[...entry.waiters].filter((w) => w.statuses.includes(status)).forEach((w) => w.finish(false))
  }

  /** A finished session's output is freed after the retention window. */
  private scheduleRelease(entry: WorktreeDebug, session: DebugSession): void {
    entry.release ??= setTimeout(() => {
      if (entry.session === session && !entry.live) {
        session.outputRing.clear()
        entry.ring.clear()
        entry.evictedThrough = entry.seq
      }
    }, this.ctx?.deps.outputRetentionMs ?? 60_000)
  }

  /** Moves new session output into the ring, and bumps when a breakpoint answer changed. */
  private sync(entry: WorktreeDebug): void {
    if (!entry.session) {
      return
    }
    const ring = entry.session.outputRing
    const entries = ring.since(entry.outputTotal)
    entry.outputTotal = ring.total
    for (const { category, output: text } of entries) {
      const event = { worktreePath: entry.root, seq: 0, ts: Date.now(), category, text }
      this.push(entry, event)
      this.outputs.push(event)
    }
    const answers = JSON.stringify(this.wires(entry).map((bp) => bp.answer))
    if (answers !== entry.answers) {
      entry.answers = answers
      this.bump(entry)
    }
  }

  /** Stamps the next seq on `event` and appends it to the bounded ring. */
  private push(entry: WorktreeDebug, event: Event): void {
    event.seq = entry.seq = ++this.seq
    entry.ring.push(event)
  }

  private bump(entry: WorktreeDebug): void {
    this.push(entry, { kind: 'state', seq: 0, status: entry.session?.state.status ?? 'idle' })
    if (this.stateListeners.size > 0) {
      const snapshot = this.buildSnapshot(entry)
      this.stateListeners.forEach((listener) => listener(snapshot))
    }
  }

  private buildSnapshot(entry: WorktreeDebug): Snapshot {
    return buildDebugSnapshot(entry, this.wires(entry))
  }
}

export const debugService = new DebugService()
