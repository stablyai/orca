import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../shared/command-token-scanner'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { selectForegroundProcessCandidate } from '../../shared/foreground-process-selection'
import { resolveOuterWrapperForegroundProcess } from '../../shared/foreground-wrapper-agent'
import { unreadableArgvName, type ProcessTableRow } from '../../shared/process-table-snapshot'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { TerminalForegroundSample } from '../../shared/terminal-foreground-observation'
import { isRetiredPtyMaster } from './node-pty-master-fd-retirement'
import { readPtsName } from './node-pty-pts-name'
import {
  normalizePtyTty,
  readTerminalTty,
  readPtyTerminalRows,
  readTerminalPs
} from './terminal-process-rows'

/** Undefined means an older native image; null means a supported query failed. */
export function readPtyForegroundGroup(proc: unknown): number | null | undefined {
  if (isRetiredPtyMaster(proc)) {
    return null
  }
  if (
    !proc ||
    typeof proc !== 'object' ||
    !('getForegroundProcessGroup' in proc) ||
    typeof proc.getForegroundProcessGroup !== 'function'
  ) {
    return undefined
  }
  try {
    const group: unknown = proc.getForegroundProcessGroup()
    return group === undefined
      ? undefined
      : typeof group === 'number' && Number.isSafeInteger(group) && group > 0
        ? group
        : null
  } catch {
    return null
  }
}

export function resolvePtyForegroundMembers(
  rows: readonly ProcessTableRow[],
  group: number
): TerminalForegroundSample {
  const front = rows.filter((row) => row.pgid === group && !/[TZ]/.test(row.stat))
  if (
    !front.length ||
    front.some((row) => {
      const name = unreadableArgvName(row.command)
      return !row.command.trim() || (name !== null && isShellProcess(name.replace(/^-/, '')))
    })
  ) {
    return { verdict: 'unverifiable', reason: 'foreground_argv_unreadable' }
  }
  const candidates = rows.map((row) => {
    let depth = 0
    let parent = row.ppid
    const seen = new Set([row.pid])
    while (!seen.has(parent)) {
      seen.add(parent)
      const ancestor = rows.find((r) => r.pid === parent)
      if (!ancestor) {
        break
      }
      depth++
      parent = ancestor.ppid
    }
    return { ...row, depth }
  })
  const foreground = candidates.filter((row) => row.pgid === group && !/[TZ]/.test(row.stat))
  const selected = selectForegroundProcessCandidate(foreground, candidates)
  const name = (row: ProcessTableRow): string =>
    getCommandTokenPathBasename(getFirstCommandToken(row.command)).replace(/^-/, '')
  // An interpreter running an agent script (`bash ~/.local/bin/claude`) is that agent, not a returned shell.
  const nonShell = foreground.filter(
    (row) =>
      !isShellProcess(name(row)) || recognizeAgentProcessFromCommandLine(row.command) !== null
  )
  const ordinary = [...(nonShell.length ? nonShell : foreground)].sort(
    (a, b) => b.depth - a.depth
  )[0]
  return {
    verdict: 'observed',
    source: 'pty-master',
    foregroundKind: nonShell.length ? 'non-shell' : 'shell',
    processName: front.some((row) => unreadableArgvName(row.command) !== null)
      ? null
      : selected
        ? resolveOuterWrapperForegroundProcess(selected.recognized, selected.candidate, candidates)
        : foreground.some((row) => recognizeAgentProcessFromCommandLine(row.command))
          ? null
          : name(ordinary) || null
  }
}

/** Bound both coherence attempts to one decision deadline; never poll until a program appears. */
export async function observePtyForeground(
  proc: { pid: number },
  owns: () => boolean,
  deadlineMs = Date.now() + 3_000
): Promise<TerminalForegroundSample> {
  const unknown = (reason: string): TerminalForegroundSample => ({
    verdict: 'unverifiable',
    reason
  })
  const alive = (): boolean => owns() && !isRetiredPtyMaster(proc)
  if (process.platform === 'win32') {
    return unknown('windows_foreground_unavailable')
  }
  for (let attempt = 0; attempt < 2 && Date.now() < deadlineMs; attempt++) {
    if (!alive()) {
      return unknown('session_changed')
    }
    const group = readPtyForegroundGroup(proc)
    if (group === null) {
      return unknown('master_unavailable')
    }
    const physicalTty = readPtsName(proc)
    const tty =
      group === undefined
        ? await readTerminalTty(proc.pid, Math.max(1, deadlineMs - Date.now()))
        : physicalTty
    if (
      !alive() ||
      !tty ||
      (physicalTty && normalizePtyTty(physicalTty) !== normalizePtyTty(tty))
    ) {
      return unknown('terminal_unavailable')
    }
    const rows = await readPtyTerminalRows(tty, deadlineMs - Date.now())
    if (!alive()) {
      return unknown('session_changed')
    }
    if (!rows) {
      return unknown('process_table_unreadable')
    }
    const root = rows.find((row) => row.pid === proc.pid)
    const before = group ?? root?.tpgid
    const fallbackAfter =
      group === undefined
        ? await readTerminalPs(
            ['-p', String(proc.pid), '-o', 'tpgid=,tty='],
            Math.max(1, deadlineMs - Date.now())
          )
        : null
    const match = fallbackAfter?.trim().match(/^(\d+)\s+(\S+)$/)
    const after =
      group === undefined
        ? match && normalizePtyTty(match[2]) === normalizePtyTty(tty)
          ? Number(match[1])
          : null
        : readPtyForegroundGroup(proc)
    if (!alive() || Date.now() > deadlineMs) {
      return unknown('session_changed')
    }
    if (!before || before <= 0 || !after) {
      return unknown('foreground_group_unavailable')
    }
    if (before !== after) {
      continue
    }
    if (rows.some((row) => row.tpgid !== before)) {
      continue
    }
    const sample = resolvePtyForegroundMembers(rows, before)
    return {
      ...sample,
      source: group === undefined ? 'posix-process-table' : 'pty-master',
      ...(sample.verdict === 'observed'
        ? { tty: normalizePtyTty(tty) ?? tty, foregroundPgid: before }
        : {})
    }
  }
  return unknown('foreground_group_changed')
}
