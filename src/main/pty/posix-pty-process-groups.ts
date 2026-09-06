import { execFileSync } from 'node:child_process'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'

const PROCESS_TABLE_TIMEOUT_MS = 1_000
// Why: the whole-host read runs only after the TTY-scoped one failed, and it is the last thing
// standing between a closed pane and a surviving agent process, so it gets the longer budget.
const DESCENDANT_TABLE_TIMEOUT_MS = 3_000
const PROCESS_TABLE_MAX_BYTES = 1024 * 1024

type ProcessRow = {
  pid: number
  pgid: number
  tty: string
}

type DescendantRow = {
  pid: number
  ppid: number
  pgid: number
}

export type PosixPtyProcessGroupTerminationDeps = {
  platform?: NodeJS.Platform
  currentPid?: number
  readProcessTable?: () => string
  readDescendantTable?: () => string
  signalProcessGroup?: (pgid: number) => void
}

function runPs(args: string[], timeout = PROCESS_TABLE_TIMEOUT_MS): string {
  return execFileSync('ps', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: PROCESS_TABLE_MAX_BYTES
  })
}

function readPtyProcessTable(rootPid: number): string {
  const root = runPs(['-p', String(rootPid), '-o', 'pid=,pgid=,tty='])
  const rootRow = parseProcessRows(root).find((row) => row.pid === rootPid)
  if (!rootRow || rootRow.tty === '?' || rootRow.tty === '??') {
    return root
  }
  // Why: a whole-host `ps -ax` takes nearly a second on large machines. TTY
  // selection keeps forced terminal teardown proportional to one terminal.
  return `${root}\n${runPs(['-t', rootRow.tty, '-o', 'pid=,pgid=,tty='])}`
}

function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    const pgid = Number(match[2])
    if (pid > 0 && pgid > 1) {
      rows.push({ pid, pgid, tty: match[3] })
    }
  }
  return rows
}

export function getPosixPtyProcessGroups(
  output: string,
  rootPid: number,
  currentPid = process.pid
): number[] | null {
  const rows = parseProcessRows(output)
  const root = rows.find((row) => row.pid === rootPid)
  if (!root || root.tty === '?' || root.tty === '??') {
    return null
  }
  // Why: a development daemon can inherit its launch TTY. Never group-signal
  // when Orca itself shares the PTY; fall back to the already-scoped root kill.
  if (rows.some((row) => row.pid === currentPid && row.tty === root.tty)) {
    return null
  }
  const groups = new Set(rows.filter((row) => row.tty === root.tty).map((row) => row.pgid))
  if (!groups.has(root.pgid)) {
    return null
  }
  return [...groups].sort((left, right) => {
    if (left === root.pgid) {
      return 1
    }
    if (right === root.pgid) {
      return -1
    }
    return left - right
  })
}

/**
 * Every process group under one PTY leader, proven by parentage instead of TTY: the leader's
 * own group last, so its children are dead before it is. Null when the leader is absent from the
 * table or when Orca itself sits in the tree — never group-signal a group Orca belongs to.
 */
export function getPosixDescendantProcessGroups(
  output: string,
  rootPid: number,
  currentPid = process.pid
): number[] | null {
  const rows: DescendantRow[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line)
    if (match) {
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) })
    }
  }
  const root = rows.find((row) => row.pid === rootPid)
  if (!root || root.pgid <= 1) {
    return null
  }
  const childrenByParent = new Map<number, DescendantRow[]>()
  for (const row of rows) {
    const siblings = childrenByParent.get(row.ppid)
    if (siblings) {
      siblings.push(row)
    } else {
      childrenByParent.set(row.ppid, [row])
    }
  }
  const tree = [root]
  for (let index = 0; index < tree.length; index++) {
    for (const child of childrenByParent.get(tree[index].pid) ?? []) {
      if (!tree.includes(child)) {
        tree.push(child)
      }
    }
  }
  if (tree.some((row) => row.pid === currentPid)) {
    return null
  }
  const groups = new Set(tree.filter((row) => row.pgid > 1).map((row) => row.pgid))
  groups.delete(root.pgid)
  return [...groups].sort((left, right) => left - right).concat(root.pgid)
}

function isProcessAlreadyGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH'
}

/** Force-kill every process group still attached to one POSIX PTY. */
export function forceKillPosixPtyProcessGroups(
  rootPid: number,
  fallback: () => void,
  deps: PosixPtyProcessGroupTerminationDeps = {}
): void {
  if ((deps.platform ?? process.platform) === 'win32') {
    fallback()
    return
  }
  // Why: the TTY-scoped table is the proven path — one `ps -t`, proportional to one terminal.
  // When it cannot answer (a `ps` that timed out under load, a leader already off its TTY), the
  // leader's descendant tree still proves ownership by parentage. Measured 2026-09-02 on a Mac
  // running 17 agent sessions: the TTY read failed, the leader-only fallback killed `login` and
  // left its `zsh -l` and the agent underneath alive with no controlling TTY, and each survivor
  // held an orchestration long-poll until the runtime's cap was full.
  let groups: number[] | null
  try {
    groups = getPosixPtyProcessGroups(
      (deps.readProcessTable ?? (() => readPtyProcessTable(rootPid)))(),
      rootPid,
      deps.currentPid ?? process.pid
    )
  } catch {
    groups = null
  }
  if (!groups || groups.length === 0) {
    try {
      groups = getPosixDescendantProcessGroups(
        (
          deps.readDescendantTable ??
          (() => runPs(['-axo', 'pid=,ppid=,pgid='], DESCENDANT_TABLE_TIMEOUT_MS))
        )(),
        rootPid,
        deps.currentPid ?? process.pid
      )
    } catch {
      groups = null
    }
  }
  if (!groups || groups.length === 0) {
    fallback()
    return
  }

  const signalProcessGroup =
    deps.signalProcessGroup ?? ((pgid: number) => process.kill(-pgid, 'SIGKILL'))
  let firstError: unknown
  for (const pgid of groups) {
    try {
      signalProcessGroup(pgid)
    } catch (error) {
      // Why: the PTY exit callback may reap a group between `ps` and killpg.
      // ESRCH is proof that this captured owner is already gone, not failure.
      if (!isProcessAlreadyGone(error) && firstError === undefined) {
        firstError = error
      }
      continue
    }
    // Outside the try: this catch is the ESRCH contract, and a throw from the
    // breadcrumb path would be rethrown as a failed kill.
    recordSelfInitiatedTreeKill({
      pid: pgid,
      site: 'posix-pty-process-group-sweep',
      scope: 'posix-process-group'
    })
  }
  if (firstError !== undefined) {
    throw firstError
  }
}
