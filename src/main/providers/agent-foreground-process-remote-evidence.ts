import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import type {
  PosixFence,
  RemoteForegroundEvidence,
  WindowsFence
} from '../../shared/foreground-process-evidence'
import { buildProcessTableIndex, type ProcessTableIndex } from '../../shared/process-table-index'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type {
  BatchedForegroundProcessRequest,
  BatchedForegroundProcessResult,
  RemoteForegroundEvidenceOptions
} from './agent-foreground-process-batch'

type ResolveForegroundProcesses = (
  index: ProcessTableIndex,
  requests: readonly BatchedForegroundProcessRequest[]
) => BatchedForegroundProcessResult[]

/** Resolve a host-stamped, fenced observation from one complete process-table capture. */
export function resolveRemoteForegroundEvidenceFromRows(
  request: BatchedForegroundProcessRequest,
  options: RemoteForegroundEvidenceOptions,
  rows: readonly ProcessTableRow[],
  resolveForegroundProcesses: ResolveForegroundProcesses
): RemoteForegroundEvidence {
  const metadata = {
    authorityGeneration: options.authorityGeneration,
    observationEpoch: options.observationEpoch,
    capturedAgeMs: options.capturedAgeMs,
    ptyId: options.ptyId,
    ptyIncarnationId: options.ptyIncarnationId
  }
  if (!options.ptyIncarnationId || !options.ptyId || rows.length === 0) {
    return { ...metadata, verdict: 'unverifiable', reason: 'process_table_unreadable' }
  }
  if (options.platform === 'win32') {
    // Why SSH-to-Windows is always unverifiable: POSIX has a real foreground primitive
    // (the controlling terminal's foreground process group, tpgid/pgid), so the host can
    // read which process is in front. Windows has no equivalent. Local Windows approximates
    // it by reading the native process table and walking descendants of the PTY root pid
    // (windows-foreground-process-rows.ts), but the relay has neither piece: it does not
    // import windows-process-table, its getForegroundProcessName is POSIX-shaped
    // (/proc, pgrep, lsof), and relay hosts run stock node-pty, so no ConPTY job/console
    // association is available. Returning a descendant name without a creation-time and
    // session fence would be a guess. Lifting this requires teaching the relay the Windows
    // process table plus a measured creation-time/session fence - a separate change.
    const fence: WindowsFence = {
      platform: 'windows',
      rootProcessId: request.rootPid,
      rootCreationTime: 'unavailable',
      sessionId: 'unavailable'
    }
    void fence
    return { ...metadata, verdict: 'unverifiable', reason: 'windows_ssh_foreground_unavailable' }
  }
  const root = rows.find((row) => row.pid === request.rootPid)
  if (!root || root.pgid === undefined || root.tpgid === undefined) {
    return { ...metadata, verdict: 'unverifiable', reason: 'anchor_missing' }
  }
  if (!root.tty || root.tty === '?' || root.tpgid <= 0 || !root.startTime) {
    return { ...metadata, verdict: 'unverifiable', reason: 'fence_incomplete' }
  }
  const index = buildProcessTableIndex(rows)
  const resolved = resolveForegroundProcesses(index, [request])[0]
  if (!resolved?.available) {
    return {
      ...metadata,
      verdict: 'unverifiable',
      reason: resolved?.reason ?? 'capture_incomplete'
    }
  }
  const descendants = collectDescendantRows(index, root.pid)
  // A child that owns another terminal/session is outside this PTY's
  // authority. Do not silently treat it as an idle shell.
  if (descendants.some((row) => row.tty !== undefined && row.tty !== '?' && row.tty !== root.tty)) {
    return { ...metadata, verdict: 'unverifiable', reason: 'tty_boundary' }
  }
  // Multiplexers can make a descendant appear foreground while the user is
  // actually interacting with another session. This relay has no measured
  // multiplexer/session fence, so remain conservative for the whole subtree.
  if ([root, ...descendants].some((row) => /(?:^|\s)(?:tmux|screen)(?:\s|$)/i.test(row.command))) {
    return { ...metadata, verdict: 'unverifiable', reason: 'multiplexer_boundary' }
  }
  if (
    descendants.some((row) => row.pgid === root.tpgid && (row.tty === undefined || row.tty === '?'))
  ) {
    return { ...metadata, verdict: 'unverifiable', reason: 'fence_incomplete' }
  }
  const foreground = descendants.filter((row) => row.pgid === root.tpgid && row.tty === root.tty)
  const recognized = foreground
    .map((row) => ({ row, name: recognizeAgentProcessFromCommandLine(row.command) }))
    .filter(
      (
        entry
      ): entry is {
        row: ProcessTableRow
        name: NonNullable<ReturnType<typeof recognizeAgentProcessFromCommandLine>>
      } => Boolean(entry.name)
    )
  if (recognized.length > 1) {
    return { ...metadata, verdict: 'unverifiable', reason: 'ambiguous_foreground_group' }
  }
  const candidate = recognized[0]
  const fence: PosixFence = {
    platform: 'posix',
    shellPid: root.pid,
    shellStartTime: root.startTime,
    tty: root.tty,
    foregroundPgid: root.tpgid,
    ...(candidate?.row.startTime
      ? { process: { pid: candidate.row.pid, startTime: candidate.row.startTime } }
      : {})
  }
  if (candidate && !candidate.row.startTime) {
    return { ...metadata, verdict: 'unverifiable', reason: 'candidate_start_time_missing' }
  }
  return {
    ...metadata,
    verdict: 'live',
    processName: candidate?.name.processName ?? null,
    fence
  }
}

function collectDescendantRows(index: ProcessTableIndex, rootPid: number): ProcessTableRow[] {
  const result: ProcessTableRow[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const pid = queue[cursor]
    for (const child of index.childrenByPpid.get(pid) ?? []) {
      if (seen.has(child.pid)) {
        continue
      }
      seen.add(child.pid)
      result.push(child)
      queue.push(child.pid)
    }
  }
  return result
}
