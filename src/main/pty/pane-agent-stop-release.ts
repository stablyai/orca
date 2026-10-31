import { tokenizeCommandLine } from '../../shared/agent-command-line-entrypoint'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import {
  buildProcessTableIndex,
  collectDescendantsFromIndex
} from '../../shared/process-table-index'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { isShellProcess } from '../../shared/shell-process-detection'

export type PaneProcessIdentity = { pid: number; startTime: string }
export type PaneAgentStopRelease = {
  root: PaneProcessIdentity
  shell: PaneProcessIdentity
  survivors: PaneProcessIdentity[]
  shells: PaneProcessIdentity[]
  platform: 'posix' | 'win32'
}
const same = (row: ProcessTableRow | undefined, identity: PaneProcessIdentity) =>
  row?.pid === identity.pid && row.startTime === identity.startTime && !row.stat.startsWith('Z')
const identity = (row: ProcessTableRow): PaneProcessIdentity => {
  if (!row.startTime) {
    throw new Error('survivor identity unavailable')
  }
  return { pid: row.pid, startTime: row.startTime }
}
const shell = (row: ProcessTableRow) => {
  const [name, ...args] = tokenizeCommandLine(row.command.trim().replace(/^-/, ''))
  return (
    isShellProcess(name ?? '') && args.every((arg) => /^-(?:[il]+|-login|-interactive)$/.test(arg))
  )
}

export function paneAgentStopLineageRoot(
  rows: readonly ProcessTableRow[],
  shellPid: number,
  agent: PaneProcessIdentity
): PaneProcessIdentity {
  const index = buildProcessTableIndex(rows)
  let root = index.byPid.get(agent.pid)
  if (!same(root, agent)) {
    throw new Error('agent identity unavailable')
  }
  const chain: ProcessTableRow[] = []
  const visited = new Set<number>()
  while (root && root.pid !== shellPid) {
    if (visited.has(root.pid)) {
      throw new Error('cyclic lineage')
    }
    visited.add(root.pid)
    chain.push(root)
    root = index.byPid.get(root.ppid)
  }
  if (!root) {
    throw new Error('agent left shell')
  }
  const outer = chain.findLastIndex((row) => !shell(row))
  const stopRoot = chain[Math.max(0, outer)]
  for (const wrapper of chain.slice(1, outer + 1)) {
    if (index.childrenByPpid.get(wrapper.pid)?.length !== 1) {
      throw new Error('wrapper owns other work')
    }
  }
  root = stopRoot
  return identity(root)
}
const birth = (value: string): bigint => {
  const parts = value.split(':')
  return parts.length === 2 && /^\d+$/.test(parts[0])
    ? BigInt(parts[0]) * 1_000_000n + BigInt(parts[1])
    : BigInt(parts.at(-1) ?? '')
}
const descendants = (rows: readonly ProcessTableRow[], shellPid: number) =>
  collectDescendantsFromIndex(buildProcessTableIndex(rows), shellPid, undefined)

export function capturePaneAgentStopRelease(
  rows: readonly ProcessTableRow[],
  input: {
    root: PaneProcessIdentity
    shell: PaneProcessIdentity
    agent: PaneProcessIdentity
    platform: PaneAgentStopRelease['platform']
  }
): PaneAgentStopRelease {
  const index = buildProcessTableIndex(rows)
  const targeted = new Set([
    input.agent.pid,
    ...collectDescendantsFromIndex(index, input.agent.pid).map((row) => row.pid)
  ])
  const remaining = descendants(rows, input.shell.pid).filter(
    (row) => !targeted.has(row.pid) && !row.stat.startsWith('Z')
  )
  if (remaining.some((row) => !row.command || recognizeAgentProcessFromCommandLine(row.command))) {
    throw new Error('another pane agent')
  }
  return {
    root: input.root,
    shell: input.shell,
    platform: input.platform,
    survivors: remaining.filter((row) => !shell(row)).map(identity),
    shells: remaining.filter(shell).map(identity)
  }
}

/** Only the jobs present before the stop may grow subtrees; every new shell child stays unexplained. */
export function paneAgentStopReleaseAdmits(
  rows: readonly ProcessTableRow[],
  release: PaneAgentStopRelease,
  excluding: ReadonlySet<number> = new Set()
): boolean {
  try {
    const index = buildProcessTableIndex(rows)
    const shellRow = index.byPid.get(release.shell.pid)
    if (
      index.byPid.size !== rows.length ||
      !same(index.byPid.get(release.root.pid), release.root) ||
      !same(shellRow, release.shell) ||
      (release.root.pid !== release.shell.pid &&
        !collectDescendantsFromIndex(index, release.root.pid).some(
          (row) => row.pid === release.shell.pid
        ))
    ) {
      return false
    }
    if (release.platform === 'posix') {
      if (
        !shellRow ||
        /^[Tt]/.test(shellRow.stat) ||
        shellRow.pgid === undefined ||
        shellRow.tpgid === undefined
      ) {
        return false
      }
      if (shellRow.pgid !== shellRow.tpgid) {
        const foreground = descendants(rows, release.shell.pid).filter(
          (row) =>
            row.pgid === shellRow.tpgid && row.tty === shellRow.tty && !row.stat.startsWith('Z')
        )
        if (!foreground.length || foreground.some((row) => !excluding.has(row.pid))) {
          return false
        }
      }
    }
    const allowed = new Set<number>()
    for (const survivor of release.survivors) {
      if (same(index.byPid.get(survivor.pid), survivor)) {
        allowed.add(survivor.pid)
        collectDescendantsFromIndex(index, survivor.pid).forEach((row) => allowed.add(row.pid))
      }
    }
    return descendants(rows, release.shell.pid).every((row) => {
      if (row.stat.startsWith('Z')) {
        return true
      }
      const parent = index.byPid.get(row.ppid)
      if (!parent?.startTime || !row.startTime || birth(parent.startTime) > birth(row.startTime)) {
        return false
      }
      if (excluding.has(row.pid)) {
        return true
      }
      if (!row.command || recognizeAgentProcessFromCommandLine(row.command)) {
        return false
      }
      return allowed.has(row.pid) || release.shells.some((item) => same(row, item))
    })
  } catch {
    return false
  }
}
