import type { ProviderRelayDetachPolicy } from '../protocol/daemon-provider-relay-protocol'
import { basename } from 'node:path'
import { readTerminalPs } from '../../pty/process-retirement/terminal-process-rows'

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

/** Orca's own owner helper sits under the agent for its whole life; it is not the agent's work.
 *  Linux reports at most 15 characters of a process name. */
const OWNER_HELPER = 'orca-provider-exec'.slice(0, 15)

/** True when any process other than Orca's own helper names `pid` as its parent; null when unreadable. */
export async function hasLiveChildProcess(pid: number): Promise<boolean | null> {
  const table = await readTerminalPs(['-A', '-o', 'pid=,ppid=,comm='])
  if (table === null) {
    return null
  }
  for (const row of table.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(row)
    if (
      match &&
      Number(match[2]) === pid &&
      Number(match[1]) !== pid &&
      !basename(match[3].trim()).startsWith(OWNER_HELPER)
    ) {
      return true
    }
  }
  return false
}

type IdleStopHost = {
  /** The agent's CLI pid; its children are its background shells, subagents and MCP servers. */
  pid: () => number | undefined
  attached: () => boolean
  live: () => boolean
  pendingCount: () => number
  stop: () => void
  log?: (event: string, details?: Record<string, unknown>) => void
  hasChildren?: (pid: number) => Promise<boolean | null>
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
      managed: { child: { pid?: number } }
      log?: (event: string, details?: Record<string, unknown>) => void
    }
  ): ProviderRelayIdleStop {
    return new ProviderRelayIdleStop({
      pid: () => options.managed.child.pid,
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
      pid === undefined ? null : await (this.host.hasChildren ?? hasLiveChildProcess)(pid)
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
