import { basename } from 'node:path'
import type * as Wire from '../../preload/api/debug-api'
import type { DapConnection } from './dap-connection'
import type { DebugSessionState } from './debug-session-handshake'
import {
  CODE_FIELDS,
  DebugServiceError,
  isInsideRoot,
  normalizeDebugPath,
  WITHHELD_MESSAGE,
  withheldFrom,
  type DebugAuthor,
  type DebugBreakpoint,
  type DebugBreakpointStore
} from './debug-breakpoint-store'
import {
  responseBody,
  responseList,
  type Breakpoint,
  type BreakpointEventBody,
  type Capabilities,
  type SourceBreakpoint,
  toSourceBreakpoint
} from './dap-protocol'

export const PROVISIONAL_BREAKPOINT_MESSAGE = 'breakpoint.provisionalBreakpoint'
export const UNSUPPORTED_BREAKPOINT_MESSAGE = 'unsupported by this debugger'

/** `pending` will bind (js-debug's provisional answer); `failed` will not. */
export type SessionBreakpointState = 'verified' | 'pending' | 'failed' | 'unsupported'

export type SessionBreakpointStatus = {
  /** The store entry's id. */
  id: string
  requestedLine: number
  state: SessionBreakpointState
  /** Where the adapter bound it; may differ from requestedLine. */
  line?: number
  message?: string
  adapterId?: number
}

export type SetBreakpointsArguments = {
  source: { path: string; name: string }
  breakpoints: SourceBreakpoint[]
}

/** Why a store entry cannot go to this adapter, or null when it can. */
function unsupportedFeature(entry: DebugBreakpoint, caps: Capabilities): string | null {
  if (entry.condition && !caps.supportsConditionalBreakpoints) {
    return 'conditions'
  }
  if (entry.hitCondition && !caps.supportsHitConditionalBreakpoints) {
    return 'hit conditions'
  }
  if (entry.logMessage && !caps.supportsLogPoints) {
    return 'log messages'
  }
  return null
}

/** `carried`: ids whose established answer a re-send must not weaken. */
type FileRecord = { statuses: SessionBreakpointStatus[]; sent: string[]; carried: Set<string> }

/** The adapter's answer per breakpoint for one live session, keyed by normalized file path. */
export class SessionBreakpoints {
  private readonly files = new Map<string, FileRecord>()

  constructor(private readonly bindsLazily: boolean) {}

  /** What setBreakpoints carries for `file`; unsupported entries are reported, never sent bare. */
  prepare(
    file: string,
    entries: readonly DebugBreakpoint[],
    caps: Capabilities
  ): { args: SetBreakpointsArguments; sent: string[] } {
    const previous = new Map(this.files.get(file)?.statuses.map((s) => [s.id, s]) ?? [])
    const statuses: SessionBreakpointStatus[] = []
    const breakpoints: SourceBreakpoint[] = []
    const sent: string[] = []
    const carried = new Set<string>()
    for (const entry of entries) {
      if (!entry.enabled) {
        continue
      }
      const feature = unsupportedFeature(entry, caps)
      if (feature) {
        const message = `${feature} ${UNSUPPORTED_BREAKPOINT_MESSAGE}`
        statuses.push({ id: entry.id, requestedLine: entry.line, state: 'unsupported', message })
        continue
      }
      const prior = previous.get(entry.id)
      const keep = prior && prior.requestedLine === entry.line && prior.state !== 'unsupported'
      if (keep) {
        carried.add(entry.id)
      }
      statuses.push(
        prior && keep ? prior : { id: entry.id, requestedLine: entry.line, state: 'pending' }
      )
      breakpoints.push(toSourceBreakpoint(entry))
      sent.push(entry.id)
    }
    this.files.set(file, { statuses, sent, carried })
    return { args: { source: { path: file, name: basename(file) }, breakpoints }, sent }
  }

  /**
   * Pairs the answer positionally with what was sent. A re-send never weakens an established
   * answer: js-debug answers one with [] or provisional while the breakpoints stay bound, and
   * `breakpoint` events stay the authority on later changes.
   */
  applyAnswer(
    file: string,
    sent: readonly string[],
    answer: readonly Breakpoint[],
    resend = false
  ): void {
    const record = this.files.get(file)
    if (!record) {
      return
    }
    sent.forEach((id, index) => {
      const reply = answer[index]
      const status = record.statuses.find((s) => s.id === id)
      const weakens = resend && record.carried.has(id) && !reply?.verified
      if (reply && status && !weakens) {
        this.update(status, reply)
      }
    })
  }

  /** A `breakpoint` event updates the entry the adapter id was bound to. */
  applyEvent(body: BreakpointEventBody): void {
    const id = body.breakpoint?.id
    if (id === undefined) {
      return
    }
    for (const record of this.files.values()) {
      const status = record.statuses.find((s) => s.adapterId === id)
      if (!status) {
        continue
      }
      if (body.reason === 'removed') {
        delete status.line
        Object.assign(status, { state: 'failed', message: 'removed by the debugger' })
      } else {
        this.update(status, body.breakpoint)
      }
      return
    }
  }

  status(file: string): SessionBreakpointStatus[] {
    return (this.files.get(file)?.statuses ?? []).map((s) => ({ ...s }))
  }

  private update(status: SessionBreakpointStatus, reply: Breakpoint): void {
    delete status.line
    delete status.message
    if (reply.id !== undefined) {
      status.adapterId = reply.id
    }
    if (reply.message !== undefined) {
      status.message = reply.message
    }
    if (reply.verified) {
      status.state = 'verified'
      status.line = reply.line ?? status.requestedLine
      return
    }
    const pending = this.bindsLazily && reply.message === PROVISIONAL_BREAKPOINT_MESSAGE
    status.state = pending ? 'pending' : 'failed'
  }
}

/** Sends one worktree's stored breakpoints and the exception filters to a session's leaf. */
export class SessionBreakpointSender {
  answers: SessionBreakpoints

  constructor(
    private readonly store: DebugBreakpointStore,
    private readonly root: string,
    private readonly bindsLazily: boolean,
    /** The filters the user enabled; unset means the adapter's `default: true` filters. */
    public exceptionFilters: string[] | undefined
  ) {
    this.answers = new SessionBreakpoints(bindsLazily)
  }

  reset(): void {
    this.answers = new SessionBreakpoints(this.bindsLazily)
  }

  /** The leaf's configuration: every file's breakpoints, then the exception filters. */
  async configure(connection: DapConnection, caps: Capabilities): Promise<void> {
    for (const file of this.store.files(this.root)) {
      await this.sendFile(connection, caps, file)
    }
    await this.sendExceptionFilters(connection, caps)
  }

  /** Re-sends a changed file to the leaf `liveLeaf` returns, when the session is live. */
  watch(
    liveLeaf: () => DapConnection | null,
    caps: () => Capabilities,
    log: (line: string) => void
  ): () => void {
    return this.store.onChange((root, file) => {
      const leaf = root === this.root ? liveLeaf() : null
      if (leaf) {
        const resent = this.sendFile(leaf, caps(), file, true)
        void resent.catch((e) => log(`setBreakpoints: ${String(e)}`))
      }
    })
  }

  async sendFile(connection: DapConnection, caps: Capabilities, file: string, resend = false) {
    const entries = this.store.forSession(this.root, file)
    const { args, sent } = this.answers.prepare(file, entries, caps)
    const response = await connection.request('setBreakpoints', args)
    const answer = responseList<Breakpoint>(responseBody(response).breakpoints)
    this.answers.applyAnswer(file, sent, answer, resend)
  }

  async sendExceptionFilters(connection: DapConnection, caps: Capabilities): Promise<void> {
    const defaults = (caps.exceptionBreakpointFilters ?? []).filter((f) => f.default)
    const filters = this.exceptionFilters ?? defaults.map((f) => f.filter)
    await connection.request('setExceptionBreakpoints', { filters })
  }
}

type AnswerSource = { breakpointStatus: (file: string) => SessionBreakpointStatus[] } | null

/** The session's answer for a stored breakpoint, else pending; `author` rides along for the UI. */
export function breakpointWire(
  session: AnswerSource,
  file: string,
  bp: DebugBreakpoint,
  audience: DebugAuthor | null = null
): Wire.DebugBreakpointWire {
  const found = session?.breakpointStatus(file).find((s) => s.id === bp.id)
  const message = found && withheldFrom(bp, audience) ? WITHHELD_MESSAGE : found?.message
  const answer: Wire.DebugBreakpointAnswer = found
    ? { state: found.state, line: found.line, message }
    : { state: 'pending', message: bp.enabled ? 'not sent to a debugger' : 'disabled' }
  return { ...bp, path: file, answer }
}

type Fields = Wire.DebugBreakpointFields

/** Breakpoint writes under a root main already trusted: a file outside it, or another root's id, is refused. */
export class ScopedBreakpoints {
  constructor(readonly store: DebugBreakpointStore) {}

  /** Every breakpoint of the root with the session's answer, as `audience`'s session was sent it. */
  wires(at: { root: string; session: AnswerSource; origin: DebugAuthor | null }) {
    const wire = (file: string) =>
      this.store.forFile(at.root, file).map((bp) => breakpointWire(at.session, file, bp, at.origin))
    return this.store.files(at.root).flatMap(wire)
  }

  add(root: string, path: string, fields: Fields & { line: number }, author: DebugAuthor) {
    const file = this.file(root, path)
    return { file, bp: this.store.add(root, file, { ...fields, author }) }
  }

  /** Setting a code field makes the caller its author; an agent may not change a person's. */
  update(root: string, id: string, fields: Fields, origin: DebugAuthor) {
    const file = this.byId(root, id, origin)
    const author = CODE_FIELDS.some((key) => fields[key] !== undefined) ? { author: origin } : {}
    const bp = this.store.update(root, file, id, { ...fields, ...author })
    if (!bp) {
      throw new DebugServiceError('unknown-breakpoint', `No breakpoint ${id}`)
    }
    return { file, bp }
  }

  remove(root: string, id: string, origin: DebugAuthor): void {
    this.store.remove(root, this.byId(root, id, origin), id)
  }

  /** Moves by id after an edit, so a moved breakpoint keeps its condition and enabled state. */
  setFileLines(root: string, path: string, lines: readonly { id: string; line: number }[]) {
    const file = this.file(root, path)
    this.store.setFileLines(root, file, lines)
    return file
  }

  private file(root: string, path: string): string {
    const file = normalizeDebugPath(path)
    if (!isInsideRoot(root, file)) {
      throw new DebugServiceError('outside-worktree', `${path} is outside ${root}`)
    }
    return file
  }

  private byId(root: string, id: string, origin: DebugAuthor): string {
    const { store } = this
    const find = (f: string) => store.forFile(root, f).find((bp) => bp.id === id)
    const file = store.files(root).find(find)
    if (!file) {
      throw new DebugServiceError('unknown-breakpoint', `No breakpoint ${id} in ${root}`)
    }
    if (origin === 'cli' && find(file)?.author !== 'cli') {
      throw new DebugServiceError(
        'human-session',
        'A person set this breakpoint; agents may not change it.'
      )
    }
    return file
  }
}

/** What a worktree's snapshot is built from; the service's per-worktree entry. */
export type DebugSnapshotSource = {
  seq: number
  root: string
  session: { state: DebugSessionState; capabilities: Capabilities } | null
  launch: { spec: { name: string; adapterId: string } } | null
  threads: Wire.DebugThreadWire[]
  exceptionFilters: string[] | undefined
  lastError: string | null
}

/** The wire snapshot the UI and the CLI consume verbatim: `stopped` is non-null only with a thread id. */
export function buildDebugSnapshot(
  entry: DebugSnapshotSource,
  breakpoints: Wire.DebugBreakpointWire[]
): Wire.DebugSnapshot {
  const state = entry.session?.state
  const capabilities = entry.session?.capabilities ?? {}
  const available = (capabilities.exceptionBreakpointFilters ?? []).map((f) => ({
    filter: f.filter,
    label: f.label,
    default: f.default ?? false
  }))
  const defaults = available.filter((f) => f.default).map((f) => f.filter)
  const { stoppedReason, threadId, allThreadsStopped = false, description } = state ?? {}
  const stopped =
    state?.status === 'stopped' && typeof threadId === 'number'
      ? { reason: stoppedReason ?? 'unknown', threadId, allThreadsStopped }
      : null
  return {
    seq: entry.seq,
    worktreePath: entry.root,
    status: state?.status ?? 'idle',
    configName: entry.launch?.spec.name ?? null,
    adapterId: entry.launch?.spec.adapterId ?? null,
    capabilities,
    stopped: stopped && description ? { ...stopped, description } : stopped,
    threads: entry.threads,
    breakpoints,
    exceptionFilters: { available, enabled: entry.exceptionFilters ?? defaults },
    lastError: entry.lastError
  }
}
