import type { DescendantTreeVerdict } from './pty-descendant-exit-verification'
import { windowsDescendantsFromRows } from './providers/windows-foreground-process-rows'
import { readWindowsProcessTableFresh } from './windows/windows-process-table'
import { terminateWindowsProcessTree } from './windows-process-tree-kill'

export const WINDOWS_DESCENDANT_KILL_VERIFY_MS = 3_500
const WINDOWS_DESCENDANT_POLL_MS = 100

/**
 * A Windows descendant tree captured while its root was alive, with the
 * PID-reuse guard the POSIX snapshot gets from ps lstart: a row only counts as
 * the same process when its creation time still matches. Rows without a
 * creation time are never signalled, because a bare pid cannot be re-identified,
 * but they are counted: a descendant that was seen and denied identification
 * is one no later read can prove gone.
 */
export type WindowsProcessIdentity = { pid: number; creationTimeMs: number }

export type WindowsDescendantSnapshot = {
  root: WindowsProcessIdentity
  descendants: WindowsProcessIdentity[]
  /** Descendants seen in the walk that denied the creation-time query. */
  unidentifiedCount: number
  capturedAtMs: number
  /** Per-PID boundaries retained when close refreshes merge snapshots. */
  capturedAtMsByPid?: Readonly<Record<string, number>>
}

export type WindowsDescendantVerificationDeps = {
  readTable?: () => Promise<{ pid: number; ppid: number; creationTimeMs?: number }[]>
  now?: () => number
  wait?: (ms: number) => Promise<void>
  verifyMs?: number
}

/** Revalidate a Windows PID/creation-time identity immediately before a kill. */
export async function verifyWindowsProcessIdentity(
  target: WindowsProcessIdentity,
  deps: Pick<WindowsDescendantVerificationDeps, 'readTable'> = {}
): Promise<boolean> {
  if (!Number.isInteger(target.pid) || target.pid <= 0 || !Number.isFinite(target.creationTimeMs)) {
    return false
  }
  const table = await (deps.readTable ?? readWindowsProcessTableFresh)().catch(() => null)
  const current = table?.filter((row) => row.pid === target.pid) ?? []
  return current.length === 1 && current[0]?.creationTimeMs === target.creationTimeMs
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Snapshot a Windows root's descendants while it is still alive. Resolves null
 * (never rejects) when the table is unreadable or the root is absent — the same
 * contract as the POSIX walk, because "cannot see" is never "nothing is there".
 */
export async function captureWindowsDescendantSnapshot(
  rootPid: number,
  deps: WindowsDescendantVerificationDeps = {}
): Promise<WindowsDescendantSnapshot | null> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return null
  }
  const capturedAtMs = (deps.now ?? Date.now)()
  // One table read, not a walk plus an identity read: each is bounded in
  // seconds, and this runs inside the close ladder's budget.
  const table = await (deps.readTable ?? readWindowsProcessTableFresh)().catch(() => null)
  const descendants = table && windowsDescendantsFromRows(table, rootPid)
  const root = table?.find((row) => row.pid === rootPid)
  if (!descendants || typeof root?.creationTimeMs !== 'number') {
    return null
  }
  return {
    root: { pid: root.pid, creationTimeMs: root.creationTimeMs },
    descendants: descendants.flatMap((row) =>
      // A descendant that denied a creation-time query cannot be told from a
      // recycled pid later, so it is never signalled on a bare pid.
      typeof row.creationTimeMs === 'number'
        ? [{ pid: row.pid, creationTimeMs: row.creationTimeMs }]
        : []
    ),
    unidentifiedCount: descendants.filter((row) => typeof row.creationTimeMs !== 'number').length,
    capturedAtMs
  }
}

export type IdentifiedWindowsTreeTerminationDeps = {
  readTable?: WindowsDescendantVerificationDeps['readTable']
  terminateTree?: (target: WindowsProcessIdentity) => Promise<void>
  ownsRoot?: () => boolean
}

/** Revalidate the captured root at the last async boundary before taskkill. */
export async function terminateIdentifiedWindowsProcessTree(
  target: WindowsProcessIdentity,
  deps: IdentifiedWindowsTreeTerminationDeps = {}
): Promise<boolean> {
  if (!(await verifyWindowsProcessIdentity(target, { readTable: deps.readTable }))) {
    return false
  }
  if (deps.ownsRoot?.() === false) {
    return false
  }
  await (
    deps.terminateTree ??
    ((identified: WindowsProcessIdentity) => terminateWindowsProcessTree(identified.pid))
  )(target)
  return true
}

/**
 * Whether a snapshotted Windows tree is gone, polled to a bounded deadline.
 *
 * Why a verification pass at all: `taskkill /T /F` resolves the same way on a
 * timeout, an access denial and a recycled root as it does on a successful
 * kill, so its completion is never evidence. Only a table read that no longer
 * shows an identity-matched row is.
 */
export async function verifyWindowsDescendantSnapshotExit(
  snapshot: WindowsDescendantSnapshot,
  deps: WindowsDescendantVerificationDeps = {}
): Promise<DescendantTreeVerdict> {
  // The most a read can prove: a descendant that denied identification was seen
  // and can never be matched gone, so "could not look" caps the verdict.
  const proven: DescendantTreeVerdict = snapshot.unidentifiedCount > 0 ? 'unverifiable' : 'exited'
  if (snapshot.descendants.length === 0) {
    return proven
  }
  const now = deps.now ?? Date.now
  const readTable = deps.readTable ?? readWindowsProcessTableFresh
  const deadline = now() + (deps.verifyMs ?? WINDOWS_DESCENDANT_KILL_VERIFY_MS)
  let verdict: DescendantTreeVerdict = 'unverifiable'
  do {
    const table = await readTable().catch(() => null)
    if (!table) {
      verdict = 'unverifiable'
    } else {
      const live = new Map(table.map((row) => [row.pid, row.creationTimeMs]))
      verdict = snapshot.descendants.some((row) => live.get(row.pid) === row.creationTimeMs)
        ? 'live'
        : proven
      if (verdict === proven) {
        return verdict
      }
    }
    if (now() >= deadline) {
      return verdict
    }
    await (deps.wait ?? delay)(WINDOWS_DESCENDANT_POLL_MS)
  } while (now() < deadline)
  return verdict
}
