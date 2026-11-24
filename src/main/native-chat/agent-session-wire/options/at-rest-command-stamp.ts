import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'

/** Cheap fingerprint of what a scan reads; undefined when it can't be read in time. */
export type AtRestCommandStamp = (
  record: AgentSessionRecord,
  cwd: string,
  signal: AbortSignal
) => Promise<string | undefined>

/** What the last good scan read, so a menu open can tell whether its sources changed since. */
export type AtRestCommandStamped = { record: AgentSessionRecord; cwd: string; stamp: string }

type StampedEntry = {
  stamped?: AtRestCommandStamped
  restamping?: Promise<void>
  scanning: boolean
  failures: number
}

/** Finished before the scan reads, so a change made while it runs still differs next time. */
export async function stampBeforeScan(
  stamp: AtRestCommandStamp | undefined,
  record: AgentSessionRecord,
  cwd: string,
  signal: AbortSignal
): Promise<AtRestCommandStamped | undefined> {
  // Never rejects: the scan may fail first and leave this unawaited.
  const value = await stamp?.(record, cwd, signal).catch(() => undefined)
  return value === undefined ? undefined : { record, cwd, stamp: value }
}

/** Unchanged sources keep the cached list without starting a scan; concurrent opens share one check. */
export function rescanIfStampChanged(
  entry: StampedEntry,
  stamp: AtRestCommandStamp,
  owned: () => boolean,
  rescan: () => void
): Promise<void> | undefined {
  const last = entry.stamped
  // After a failed scan the catalog's retry schedule decides, not every menu open.
  if (!last || entry.scanning || entry.failures > 0) {
    return undefined
  }
  entry.restamping ??= stamp(last.record, last.cwd, new AbortController().signal)
    .catch(() => undefined)
    .then((value) => {
      if (
        value !== undefined &&
        value !== last.stamp &&
        entry.stamped === last &&
        !entry.scanning &&
        owned()
      ) {
        rescan()
      }
    })
    .finally(() => {
      entry.restamping = undefined
    })
  return entry.restamping
}
