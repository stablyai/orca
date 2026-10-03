import type { IPty } from 'node-pty'
import { isShellProcess } from '../../../shared/shell-process-detection'
import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../../shared/command-token-scanner'
import {
  collectDescendantsFromIndex,
  getProcessTableIndex
} from '../../../shared/process-table-index'
import {
  hasControllingTerminal,
  type ProcessTableRow
} from '../../../shared/process-table-snapshot'
import {
  getFreshProcessTableSnapshot,
  getProcessTableSnapshot
} from '../../../shared/process-table-snapshot-reader'
import { selectForegroundProcessCandidate } from '../../../shared/foreground-process-selection'
import { resolveOuterWrapperForegroundProcess } from '../../../shared/foreground-wrapper-agent'
import { recognizeAgentProcess } from '../../../shared/agent-process-recognition'
import {
  resolveAgentForegroundProcessWithAvailability,
  type AgentForegroundProcessResolution,
  type AgentForegroundResolutionOptions
} from '../../providers/agent-foreground-process'
import { readWindowsPtyJobProcessIds } from '../../providers/windows-pty-job-membership'
import { ptyShellProcessId } from '../../windows/windows-pty-job'
import {
  readWindowsProcessIdentityTable,
  readWindowsProcessIdentityTableFresh
} from '../../windows/windows-process-table'

export function ptyProcessNameIsSpawnFile(proc: IPty): boolean {
  return 'processNameIsSpawnFile' in proc && proc.processNameIsSpawnFile === true
}

export function createPtyForegroundResolver(
  proc: IPty
): typeof resolveAgentForegroundProcessWithAvailability {
  return ptyProcessNameIsSpawnFile(proc)
    ? (_pid, fallback, options) => resolveSpawnFileForegroundProcess(proc, fallback, options)
    : resolveAgentForegroundProcessWithAvailability
}

export function shouldCachePtyForeground(name: string | null, staticName: boolean): name is string {
  return (
    name !== null && (recognizeAgentProcess(name) !== null || (staticName && !isShellProcess(name)))
  )
}

export function resolveSpawnFileForegroundFromRows(
  rows: readonly ProcessTableRow[],
  rootPid: number
): AgentForegroundProcessResolution {
  const index = getProcessTableIndex(rows)
  const root = index.byPid.get(rootPid)
  if (!root || !root.tpgid || root.tpgid < 0 || !hasControllingTerminal(root.tty)) {
    return { available: false, processName: null }
  }
  const tree = [{ ...root, depth: 0 }, ...collectDescendantsFromIndex(index, rootPid)]
  const candidates = tree
    .filter((row) => row.pgid === root.tpgid && row.tty === root.tty && !/[TZ]/.test(row.stat))
    .sort((left, right) => right.depth - left.depth)
  const foreground = candidates[0]
  if (!foreground) {
    return { available: false, processName: null }
  }
  const name = getCommandTokenPathBasename(getFirstCommandToken(foreground.command)).replace(
    /^-/,
    ''
  )
  const selected = selectForegroundProcessCandidate(candidates, tree)
  return {
    available: name.length > 0,
    processName: selected
      ? resolveOuterWrapperForegroundProcess(selected.recognized, selected.candidate, tree)
      : recognizeAgentProcess(name)
        ? null
        : name || null
  }
}

export async function resolveSpawnFileForegroundProcess(
  proc: IPty,
  fallbackProcess: string | null,
  options: AgentForegroundResolutionOptions = {}
): Promise<AgentForegroundProcessResolution> {
  try {
    if (process.platform !== 'win32') {
      const rows = options.fresh
        ? await getFreshProcessTableSnapshot()
        : await getProcessTableSnapshot()
      return resolveSpawnFileForegroundFromRows(rows, proc.pid)
    }
    const resolution = await resolveAgentForegroundProcessWithAvailability(
      proc.pid,
      fallbackProcess,
      options
    )
    if (!resolution.available || recognizeAgentProcess(resolution.processName)) {
      return resolution
    }
    const members = readWindowsPtyJobProcessIds(proc)
    const shellPid = ptyShellProcessId(proc)
    if (!members || shellPid === undefined) {
      return { available: false, processName: null }
    }
    if (members.size === 1) {
      return { available: true, processName: fallbackProcess }
    }
    const rows = options.fresh
      ? await readWindowsProcessIdentityTableFresh()
      : await readWindowsProcessIdentityTable()
    const candidate = collectDescendantsFromIndex(getProcessTableIndex(rows), shellPid)
      .filter((row) => members.has(row.pid))
      .sort((left, right) => right.depth - left.depth)[0]
    // Only the agent resolver can grant an identity after ambiguity and console checks.
    if (candidate && recognizeAgentProcess(candidate.name)) {
      return resolution
    }
    return candidate
      ? { available: true, processName: candidate.name, processId: candidate.pid }
      : { available: false, processName: null }
  } catch {
    return { available: false, processName: null }
  }
}
