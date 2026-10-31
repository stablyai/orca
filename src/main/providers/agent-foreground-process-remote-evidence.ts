import { hasControllingTty } from '../../shared/posix-controlling-terminal'
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
    // Windows SSH lacks native process-table, creation-time and ConPTY session proof; descendant names cannot authorize foreground identity.
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
  if (!hasControllingTty(root.tty) || root.tpgid <= 0 || !root.startTime) {
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
  // Another controlling terminal falls outside this pane; its work cannot prove this shell idle.
  if (descendants.some((row) => hasControllingTty(row.tty) && row.tty !== root.tty)) {
    return { ...metadata, verdict: 'unverifiable', reason: 'tty_boundary' }
  }
  // Without a multiplexer/session fence, apparent foreground ancestry cannot establish user focus.
  if ([root, ...descendants].some((row) => /(?:^|\s)(?:tmux|screen)(?:\s|$)/i.test(row.command))) {
    return { ...metadata, verdict: 'unverifiable', reason: 'multiplexer_boundary' }
  }
  if (descendants.some((row) => row.pgid === root.tpgid && !hasControllingTty(row.tty))) {
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
  // One agent can hold two rows (npm Codex: node codex.js spawning native codex; Gemini relaunching itself in node):
  // that names it, and the outermost row is its fence. Two different agents prove neither.
  if (new Set(recognized.map((entry) => entry.name.agent)).size > 1) {
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
