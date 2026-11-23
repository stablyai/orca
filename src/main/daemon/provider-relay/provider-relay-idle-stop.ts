import type { ProviderRelayDetachPolicy } from '../protocol/daemon-provider-relay-protocol'
import { readFreshProcessTable } from '../../pty/process-retirement/pty-descendant-fresh-table'
import type { ProcessTableRow } from '../../pty/process-retirement/pty-process-table-parser'

const MAX_POLICY_MARKERS = 16
const MAX_MARKER_CHARS = 128
/** A chat that turned out busy is looked at again after this, not after a whole idle window. */
const BUSY_RECHECK_MS = 60_000
/** Work notifications are small; a huge line naming a marker is output, not a turn boundary. */
const MAX_MARKER_LINE_CHARS = 64 * 1024

function markers(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.length <= MAX_POLICY_MARKERS &&
    value.every((marker) => typeof marker === 'string' && marker.length <= MAX_MARKER_CHARS)
    ? (value as string[])
    : null
}

/** Untrusted wire input; anything malformed keeps today's behavior (the agent keeps running). */
export function readProviderRelayDetachPolicy(value: unknown): ProviderRelayDetachPolicy | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const policy = value as Record<string, unknown>
  const idleStopMs = policy.idleStopMs
  const workStarts = markers(policy.workStarts)
  const workEnds = markers(policy.workEnds)
  if (
    !(idleStopMs === null || (typeof idleStopMs === 'number' && idleStopMs > 0)) ||
    typeof policy.working !== 'boolean' ||
    !workStarts ||
    !workEnds
  ) {
    return null
  }
  return {
    idleStopMs: idleStopMs === null ? null : Math.min(idleStopMs, 2 ** 31 - 1),
    working: policy.working,
    workStarts,
    workEnds
  }
}

/** The busy recheck's cadence: one table read serves every detached relay checking meanwhile. */
const SHARED_TABLE_MS = 60_000
let sharedTable: { readAt: number; rows: Promise<ProcessTableRow[] | null> } | null = null

function processRows(): Promise<ProcessTableRow[] | null> {
  if (sharedTable && Date.now() - sharedTable.readAt < SHARED_TABLE_MS) {
    return sharedTable.rows
  }
  const rows = readFreshProcessTable().then(
    (capture) => capture.rows,
    () => null
  )
  sharedTable = { readAt: Date.now(), rows }
  return rows
}

/**
 * True when a process other than the ones in `ignore` (Orca's own owner helper, which sits under
 * the agent for its whole life) names `pid` as its parent; null when the table can't be read.
 */
export async function hasLiveChildProcess(
  pid: number,
  ignore: ReadonlySet<number> = new Set()
): Promise<boolean | null> {
  const rows = await processRows()
  if (rows === null) {
    return null
  }
  return rows.some(
    (row) => row.ppid === pid && row.pid !== pid && !ignore.has(row.pid) && !row.zombie
  )
}

type IdleStopHost = {
  /** The agent's CLI pid; its children are its background shells, subagents and MCP servers. */
  pid: () => number | undefined
  /** Orca's own processes under the agent (its owner helper), which are not the agent's work. */
  helperPids?: () => ReadonlySet<number>
  attached: () => boolean
  live: () => boolean
  pendingCount: () => number
  stop: () => void
  log?: (event: string, details?: Record<string, unknown>) => void
  hasChildren?: (pid: number, ignore?: ReadonlySet<number>) => Promise<boolean | null>
}

/**
 * The user's native-chat idle stop for a detached agent. Working, waiting on an approval, or
 * owning live child processes is never idle; an unreadable process table counts as busy.
 */
export class ProviderRelayIdleStop {
  /** The app's policy, known from spawn or attach; it also covers a stream that just drops. */
  private policy: ProviderRelayDetachPolicy | null = null
  private armed = false
  private working = false
  private lastActivityAt = Date.now()
  private timer: ReturnType<typeof setTimeout> | null = null
  private checking = false

  constructor(private readonly host: IdleStopHost) {}

  static forRelay(
    relay: {
      readonly live: boolean
      readonly attachedClientId: string | null
      readonly pending: { readonly size: number }
      close: () => Promise<unknown>
    },
    options: {
      relayId: string
      managed: { child: { pid?: number; watcherPid?: number; writerPid?: number } }
      log?: (event: string, details?: Record<string, unknown>) => void
    }
  ): ProviderRelayIdleStop {
    return new ProviderRelayIdleStop({
      pid: () => options.managed.child.pid,
      helperPids: () => {
        const { watcherPid } = options.managed.child
        return new Set(watcherPid === undefined ? [] : [watcherPid])
      },
      attached: () => relay.attachedClientId !== null,
      live: () => relay.live,
      pendingCount: () => relay.pending.size,
      stop: () => void relay.close().catch(() => {}),
      log: (event, details) => options.log?.(event, { relayId: options.relayId, ...details })
    })
  }

  /** Learned while attached, so work boundaries are tracked before any detach. */
  configure(policy: ProviderRelayDetachPolicy | null): void {
    if (policy) {
      this.policy = policy
    }
  }

  /** The window starts now; a detach's own policy says whether the chat is mid-turn. */
  arm(policy: ProviderRelayDetachPolicy | null): void {
    if (policy) {
      this.policy = policy
      this.working = policy.working
    }
    this.armed = this.policy !== null
    this.lastActivityAt = Date.now()
    this.schedule(this.armed ? (this.policy?.idleStopMs ?? null) : null)
  }

  disarm(): void {
    this.armed = false
    this.clearTimer()
  }

  /** Called for every stdout line; only a small line naming a marker is parsed. */
  observeAgentLine(line: string): void {
    const policy = this.policy
    if (!policy) {
      return
    }
    this.lastActivityAt = Date.now()
    if (line.length > MAX_MARKER_LINE_CHARS) {
      return
    }
    const starts = policy.workStarts.some((marker) => line.includes(marker))
    const ends = policy.workEnds.some((marker) => line.includes(marker))
    if (!starts && !ends) {
      return
    }
    const name = messageName(line)
    if (name !== null && policy.workStarts.includes(name)) {
      this.working = true
    } else if (name !== null && policy.workEnds.includes(name)) {
      this.working = false
    }
  }

  private schedule(delayMs: number | null): void {
    this.clearTimer()
    if (delayMs === null) {
      return
    }
    this.timer = setTimeout(() => void this.check(), delayMs)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async check(): Promise<void> {
    this.timer = null
    const policy = this.policy
    if (!this.armed || !policy || policy.idleStopMs === null || this.checking) {
      return
    }
    const quietFor = Date.now() - this.lastActivityAt
    if (quietFor < policy.idleStopMs) {
      this.schedule(policy.idleStopMs - quietFor)
      return
    }
    if (!this.host.live() || this.host.attached()) {
      return
    }
    if (this.working || this.host.pendingCount() > 0) {
      this.schedule(BUSY_RECHECK_MS)
      return
    }
    const pid = this.host.pid()
    this.checking = true
    const children =
      pid === undefined
        ? null
        : await (this.host.hasChildren ?? hasLiveChildProcess)(pid, this.host.helperPids?.())
    this.checking = false
    // Anything that changed during the read (attach, output, a new turn) wins over the stop.
    if (
      !this.armed ||
      this.policy !== policy ||
      this.host.attached() ||
      !this.host.live() ||
      this.working ||
      this.host.pendingCount() > 0 ||
      Date.now() - this.lastActivityAt < policy.idleStopMs
    ) {
      if (this.armed && this.policy === policy) {
        this.schedule(BUSY_RECHECK_MS)
      }
      return
    }
    if (children !== false) {
      this.schedule(BUSY_RECHECK_MS)
      return
    }
    this.armed = false
    this.host.log?.('relay-idle-stop', { quietMs: Date.now() - this.lastActivityAt })
    this.host.stop()
  }
}

function messageName(line: string): string | null {
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null) {
      return null
    }
    const { method, type } = value as { method?: unknown; type?: unknown }
    return typeof method === 'string' ? method : typeof type === 'string' ? type : null
  } catch {
    return null
  }
}
