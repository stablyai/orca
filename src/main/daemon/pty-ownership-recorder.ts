// Writes down what the daemon owns, shortly after it starts owning it.
//
// The record is a consequence of the spawn, never a reservation ahead of one: it is written after
// node-pty has handed back a live pid, so a create that failed leaves nothing behind to be
// reaped. And it is bookkeeping, so it never gates the create — the spawn only enqueues, and the
// probe and the write happen later, batched, off the spawn path.

import { runProcess } from '../../shared/child-process/run-process'
import {
  ptyOwnershipRecordKey,
  ttyNameFromSlavePath,
  type PtyOwnershipRecord
} from './pty-ownership-record'
import type { PtyOwnershipRecordStore } from './pty-ownership-record-store'

/** Spawns arriving together (a restored workspace opens many at once) share one probe and one
 *  store write instead of paying for each. */
const RECORD_BATCH_DELAY_MS = 1_000

/** Nothing waits on this probe, so it gets the deadline a background scan gets: a loaded host can
 *  take seconds to answer `ps`, and a probe that times out only costs the start time. */
const IDENTITY_PROBE_TIMEOUT_MS = 15_000

const IDENTITY_PROBE_MAX_OUTPUT_BYTES = 256 * 1024

export type SpawnedPtyIdentity = {
  sessionId: string
  incarnationId: string
  pid: number
  /** node-pty's slave device path, when the backend has one to give. */
  slavePath?: string
}

export type PtyRootIdentity = { pgid: number; startedAt: string }

/** `ps -o pid=,pgid=,lstart=` rows, keyed by pid. Rows that do not parse are left out. */
export function parsePtyRootIdentities(psOutput: string): Map<number, PtyRootIdentity> {
  const identities = new Map<number, PtyRootIdentity>()
  for (const line of psOutput.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    const pgid = Number(match[2])
    if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(pgid) && pgid > 0) {
      identities.set(pid, { pgid, startedAt: match[3] })
    }
  }
  return identities
}

async function probePtyRootIdentities(
  pids: readonly number[]
): Promise<Map<number, PtyRootIdentity>> {
  const result = await runProcess({
    program: 'ps',
    args: ['-p', pids.join(','), '-o', 'pid=,pgid=,lstart='],
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    timeoutMs: IDENTITY_PROBE_TIMEOUT_MS,
    maxOutputBytes: IDENTITY_PROBE_MAX_OUTPUT_BYTES
  })
  // `ps -p` exits non-zero when any listed pid is gone; the rows for the others are still good.
  return result.timedOut ? new Map() : parsePtyRootIdentities(result.stdout)
}

export type PtyOwnershipRecorderOptions = {
  store: PtyOwnershipRecordStore
  daemon: { pid: number; startedAtMs: number | null }
  platform?: NodeJS.Platform
  now?: () => number
  probeIdentities?: (pids: readonly number[]) => Promise<Map<number, PtyRootIdentity>>
  /** Whether the daemon still drives this exact PTY. A probe answered after the root exited could
   *  describe whatever reused its pid, so only a still-live root's answer is written down. */
  isLive: (identity: SpawnedPtyIdentity) => boolean
  batchDelayMs?: number
}

type PendingRecord = { identity: SpawnedPtyIdentity; recordedAt: number }

/**
 * Records each PTY's root identity: pid, start time and process group.
 *
 * A record the probe never completes is still written with a null start time, which authorizes
 * nothing on its own; the reconciler's next live tick completes it from its own capture while the
 * root is still alive.
 */
export class PtyOwnershipRecorder {
  private pending = new Map<string, PendingRecord>()
  private retiring = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> = Promise.resolve()

  constructor(private readonly options: PtyOwnershipRecorderOptions) {}

  private get supported(): boolean {
    return (this.options.platform ?? process.platform) !== 'win32'
  }

  record(identity: SpawnedPtyIdentity): void {
    if (!this.supported || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) {
      return
    }
    const now = this.options.now ?? Date.now
    this.pending.set(ptyOwnershipRecordKey(identity.sessionId, identity.incarnationId), {
      identity,
      recordedAt: now()
    })
    this.schedule()
  }

  /**
   * The session ended under this daemon, so its record stops being evidence of anything the
   * reconciler may act on. Whatever it left running outlived a teardown that did run; answering
   * for that is the natural-exit sweep's job, not a reason to hand a stale snapshot kill authority.
   */
  retire(sessionId: string): void {
    if (!this.supported) {
      return
    }
    this.retiring.add(sessionId)
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.options.batchDelayMs ?? RECORD_BATCH_DELAY_MS)
    // Unref'd so a pending batch can never be the reason an idle daemon stays alive.
    this.timer.unref?.()
  }

  /** Probe and write everything queued so far. Exposed so tests need not wait on the timer. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const batch = [...this.pending.values()]
    const retiring = this.retiring
    this.pending = new Map()
    this.retiring = new Set()
    // Serialized so two batches never interleave their read-modify-write of the store.
    this.inFlight = this.inFlight.then(() => this.writeBatch(batch, retiring))
    return this.inFlight
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
    this.retiring.clear()
  }

  private async writeBatch(
    batch: readonly PendingRecord[],
    retiring: ReadonlySet<string>
  ): Promise<void> {
    if (batch.length === 0 && retiring.size === 0) {
      return
    }
    let probed = new Map<number, PtyRootIdentity>()
    try {
      if (batch.length > 0) {
        probed = await (this.options.probeIdentities ?? probePtyRootIdentities)(
          batch.map((entry) => entry.identity.pid)
        )
      }
    } catch {
      // Unprobed rows are still written; the reconciler completes them while the root is alive.
    }
    const records: PtyOwnershipRecord[] = []
    for (const { identity, recordedAt } of batch) {
      if (!this.options.isLive(identity)) {
        continue
      }
      const probedRoot = probed.get(identity.pid)
      // The root was born before it was queued; anything later is a process that reused its pid.
      const root =
        probedRoot && Date.parse(probedRoot.startedAt) <= recordedAt ? probedRoot : undefined
      records.push({
        sessionId: identity.sessionId,
        incarnationId: identity.incarnationId,
        root: { pid: identity.pid, startedAt: root?.startedAt ?? null },
        processes: [],
        pgids: root ? [root.pgid] : [],
        tty: ttyNameFromSlavePath(identity.slavePath),
        daemon: { ...this.options.daemon },
        recordedAt
      })
    }
    // A session id respawned since it ended keeps its newer, live generation's record.
    const retire = (existing: PtyOwnershipRecord): boolean =>
      retiring.has(existing.sessionId) &&
      !this.options.isLive({ ...existing, pid: existing.root.pid })
    try {
      this.options.store.upsertMany(records, retiring.size > 0 ? retire : undefined)
    } catch {
      // A terminal must open whether or not its bookkeeping did.
    }
  }
}
