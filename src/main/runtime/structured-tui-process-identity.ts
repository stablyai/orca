import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { getFreshProcessTableSnapshot } from '../../shared/process-table-snapshot-reader'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import type { AgentSessionHandleProvider } from '../../shared/agent-session-provider-handle'
import { queryWindowsProcessRowsFresh } from '../providers/windows-foreground-process-rows'
import {
  PROCESS_START_TIME_TOLERANCE_MS,
  readProcessStartTimeMs
} from './agent-session-process-identity-probe'

type ProcessRow = { pid: number; ppid: number; command: string; foreground: boolean }

const STRUCTURED_TUI_PROCESS_WAIT_MS = 5_000
const STRUCTURED_TUI_PROCESS_POLL_MS = 50
// Why: every poll forks a whole-machine `ps` (~0.065 CPU-s at 1,460 processes),
// and the 5s ceiling is only reached when the child never appears at all — so the
// tight interval buys nothing there. Hold it for the window in which a spawning
// child plausibly lands (detection latency byte-identical), then widen. Past the
// window the added latency is bounded by one interval.
const STRUCTURED_TUI_PROCESS_FAST_POLL_WINDOW_MS = 1_000
const STRUCTURED_TUI_PROCESS_MAX_POLL_MS = 500

function descendants(rows: ProcessRow[], rootPid: number): (ProcessRow & { depth: number })[] {
  const children = new Map<number, ProcessRow[]>()
  const rowByPid = new Map<number, ProcessRow>()
  for (const row of rows) {
    const bucket = children.get(row.ppid)
    if (bucket) {
      bucket.push(row)
    } else {
      children.set(row.ppid, [row])
    }
    // Array#find below was first-match-wins for duplicate PIDs; retain that contract in the index.
    if (!rowByPid.has(row.pid)) {
      rowByPid.set(row.pid, row)
    }
  }
  const found: (ProcessRow & { depth: number })[] = []
  const pending = [{ pid: rootPid, depth: 0 }]
  const seen = new Set<number>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (seen.has(current.pid)) {
      continue
    }
    seen.add(current.pid)
    const row = rowByPid.get(current.pid)
    if (row) {
      found.push({ ...row, depth: current.depth })
    }
    for (const child of children.get(current.pid) ?? []) {
      pending.push({ pid: child.pid, depth: current.depth + 1 })
    }
  }
  return found
}

function excludedProcessTreePids(
  rows: ProcessRow[],
  rootPids: ReadonlySet<number> | undefined
): ReadonlySet<number> {
  if (!rootPids || rootPids.size === 0) {
    return new Set()
  }
  const excluded = new Set(rootPids)
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const bucket = children.get(row.ppid)
    if (bucket) {
      bucket.push(row.pid)
    } else {
      children.set(row.ppid, [row.pid])
    }
  }
  const pending = [...rootPids]
  while (pending.length > 0) {
    for (const childPid of children.get(pending.pop()!) ?? []) {
      if (!excluded.has(childPid)) {
        excluded.add(childPid)
        pending.push(childPid)
      }
    }
  }
  return excluded
}

async function resolveExcludedProcessTreePids(
  rows: ProcessRow[],
  identities: readonly { pid: number; processStartTimeMs: number | null }[] | undefined,
  platform: NodeJS.Platform,
  readStartTime: (pid: number, platform?: NodeJS.Platform) => Promise<number | null>
): Promise<ReadonlySet<number>> {
  if (!identities || identities.length === 0) {
    return new Set()
  }
  const roots = new Set<number>()
  const pids = new Set<number>()
  for (const row of rows) {
    pids.add(row.pid)
  }
  for (const identity of identities) {
    if (!pids.has(identity.pid)) {
      continue
    }
    // Unavailable start time cannot prove PID reuse, so retain the conservative exclusion.
    if (identity.processStartTimeMs === null) {
      roots.add(identity.pid)
      continue
    }
    const observed = await readStartTime(identity.pid, platform)
    if (
      observed === null ||
      Math.abs(observed - identity.processStartTimeMs) <= PROCESS_START_TIME_TOLERANCE_MS
    ) {
      roots.add(identity.pid)
    }
  }
  return excludedProcessTreePids(rows, roots)
}

export function resolveStructuredTuiChildPid(
  rows: ProcessRow[],
  rootPid: number,
  agent: AgentSessionHandleProvider,
  processCommandMatches?: (command: string) => boolean,
  excludedPids?: ReadonlySet<number>
): number | null {
  const candidates = descendants(rows, rootPid).filter(
    (row) =>
      !excludedPids?.has(row.pid) &&
      recognizeAgentProcessFromCommandLine(row.command)?.agent === agent &&
      (processCommandMatches?.(row.command) ?? true)
  )
  const foreground = candidates.filter((row) => row.foreground)
  const eligible = foreground.length > 0 ? foreground : candidates
  eligible.sort((left, right) => left.depth - right.depth || left.pid - right.pid)
  if (eligible.length === 0 || eligible[1]?.depth === eligible[0]?.depth) {
    return null
  }
  return eligible[0]!.pid
}

function posixRows(rows: ProcessTableRow[]): ProcessRow[] {
  return rows.map((row) => ({
    pid: row.pid,
    ppid: row.ppid,
    command: row.command,
    foreground: row.stat.includes('+')
  }))
}

export async function readStructuredTuiProcessIdentity(input: {
  hostId: string
  rootPid: number
  spawnToken: string
  agent: AgentSessionHandleProvider
  platform?: NodeJS.Platform
  readPosixRows?: () => Promise<ProcessTableRow[]>
  readWindowsRows?: typeof queryWindowsProcessRowsFresh
  readStartTime?: (pid: number, platform?: NodeJS.Platform) => Promise<number | null>
  timeoutMs?: number
  pollIntervalMs?: number
  now?: () => number
  sleep?: (delayMs: number) => Promise<void>
  processCommandMatches?: (command: string) => boolean
  excludedProcessTreeRootIdentities?: readonly {
    pid: number
    processStartTimeMs: number | null
  }[]
}): Promise<AgentSessionProcessIdentity> {
  const platform = input.platform ?? process.platform
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
  const startedAtMs = now()
  const deadline = startedAtMs + (input.timeoutMs ?? STRUCTURED_TUI_PROCESS_WAIT_MS)
  let pollDelayMs = input.pollIntervalMs ?? STRUCTURED_TUI_PROCESS_POLL_MS

  while (true) {
    const rows: ProcessRow[] =
      platform === 'win32'
        ? (await (input.readWindowsRows ?? queryWindowsProcessRowsFresh)()).map((row) => ({
            pid: row.pid,
            ppid: row.ppid,
            command: row.command,
            foreground: false
          }))
        : posixRows(await (input.readPosixRows ?? getFreshProcessTableSnapshot)())
    let rootPresent = false
    for (const row of rows) {
      if (row.pid === input.rootPid) {
        rootPresent = true
        break
      }
    }
    if (!rootPresent) {
      throw new Error('The terminal root process was not present in the process snapshot.')
    }
    const excludedPids = await resolveExcludedProcessTreePids(
      rows,
      input.excludedProcessTreeRootIdentities,
      platform,
      input.readStartTime ?? readProcessStartTimeMs
    )
    const pid = resolveStructuredTuiChildPid(
      rows,
      input.rootPid,
      input.agent,
      input.processCommandMatches,
      excludedPids
    )
    if (pid !== null) {
      return {
        hostId: input.hostId,
        pid,
        processStartTimeMs: await (input.readStartTime ?? readProcessStartTimeMs)(pid, platform),
        spawnToken: input.spawnToken
      }
    }
    const remainingMs = deadline - now()
    if (remainingMs <= 0) {
      const label = input.agent === 'codex' ? 'Codex' : 'Claude'
      throw new Error(`The resumed terminal did not expose one exact ${label} child process.`)
    }
    await sleep(Math.min(pollDelayMs, remainingMs))
    if (now() - startedAtMs >= STRUCTURED_TUI_PROCESS_FAST_POLL_WINDOW_MS) {
      // Never below the caller's interval, so an explicitly slow poll stays slow.
      pollDelayMs = Math.max(
        pollDelayMs,
        Math.min(pollDelayMs * 2, STRUCTURED_TUI_PROCESS_MAX_POLL_MS)
      )
    }
  }
}
