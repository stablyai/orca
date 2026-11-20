import type { WindowsProcessCandidate } from './process-rows'

type ConsoleReader = (pid: number) => Promise<ReadonlySet<number> | null>

const CONSOLE_HOST_NAMES = new Set(['conhost.exe', 'openconsole.exe'])

/** A process that opened its own console owns a console host child; one without it kept the console it
 * inherited, which for a direct child of the pane root is the pane's pseudo console. */
export function findOrphanOnInheritedConsole(
  candidates: readonly WindowsProcessCandidate[]
): number | undefined {
  return candidates.find(
    (candidate) =>
      candidate.depth === 1 &&
      !candidates.some(
        (child) => child.ppid === candidate.pid && CONSOLE_HOST_NAMES.has(child.name.toLowerCase())
      )
  )?.pid
}

/** Windows reuses a dead root's pid, so only an orphan inside this pane's job may speak for its console. */
export function paneMemberConsoleReader(
  rootPid: number,
  listJobProcessIds: () => readonly number[] | null,
  readConsole: ConsoleReader
): (memberPid?: number) => Promise<ReadonlySet<number> | null> {
  return async (memberPid) =>
    memberPid === undefined
      ? readConsole(rootPid)
      : listJobProcessIds()?.includes(memberPid)
        ? readConsole(memberPid)
        : null
}
