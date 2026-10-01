import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import {
  listPerGeneration,
  USER_FACING_DAEMON_LISTING_TIMEOUT_MS
} from '../daemon/daemon-generation-listing'
import type { SessionInfo } from '../daemon/types'
import {
  collectGenerations,
  generationDeadline,
  type DaemonAdapterSet
} from './pty-management-generations'

// Why: poll past the daemon's 5s SIGTERM→SIGKILL ladder (KILL_TIMEOUT_MS in session.ts), else slow-exiting shells falsely look "refused".
const MAX_POLL_ATTEMPTS = 65
const POLL_INTERVAL_MS = 100

export type DaemonKillAllResult = {
  killedCount: number
  remainingCount: number
  /** Sessions whose version stopped answering mid-kill: neither counted killed nor remaining. */
  unverifiedCount: number
  /** Versions that did not answer the first listing, so none of their sessions were asked to stop. */
  unreachedVersionCount: number
  killedSessionIds: string[]
}

type Target = { adapter: DaemonPtyAdapter; sessionId: string; incarnationId?: string }

// Why the exact identity: the same id can be live in two versions, and one copy ending says
// nothing about the other.
function identityKey(
  protocolVersion: number,
  session: Pick<SessionInfo, 'sessionId' | 'incarnationId'>
): string {
  return JSON.stringify([protocolVersion, session.sessionId, session.incarnationId ?? null])
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Asks every version that answered to end its sessions, then polls until they are gone. */
export async function killAllDaemonSessions(
  adapterSet: DaemonAdapterSet
): Promise<DaemonKillAllResult> {
  const generations = await collectGenerations(adapterSet)
  const unreachedVersionCount = generations.filter((g) => g.contact === 'unverifiable').length
  // Why: snapshot identities up front so mid-kill respawns aren't counted as "remaining".
  const remaining = new Map<string, Target>()
  for (const generation of generations) {
    const adapter = adapterSet.adapters.find(
      (a) => a.protocolVersion === generation.protocolVersion
    )
    if (!adapter || generation.contact !== 'live') {
      continue
    }
    for (const session of generation.sessions) {
      remaining.set(identityKey(adapter.protocolVersion, session), {
        adapter,
        sessionId: session.sessionId,
        ...(session.incarnationId ? { incarnationId: session.incarnationId } : {})
      })
    }
  }
  const initial = new Map(remaining)
  if (initial.size === 0) {
    return {
      killedCount: 0,
      remainingCount: 0,
      unverifiedCount: 0,
      unreachedVersionCount,
      killedSessionIds: []
    }
  }
  // Why: no retry — session.kill() is idempotent and runs its own kill ladder; swallow rejections since remainingCount reports stuck sessions.
  await Promise.allSettled(
    [...initial.values()].map(({ adapter, sessionId }) =>
      adapter.shutdown(sessionId, { immediate: true }).catch(() => {})
    )
  )
  const unverified = new Map<string, Target>()
  let polled = [...new Set([...initial.values()].map(({ adapter }) => adapter))]
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS && remaining.size > 0; attempt += 1) {
    await sleep(POLL_INTERVAL_MS)
    const cap = Date.now() + USER_FACING_DAEMON_LISTING_TIMEOUT_MS
    const deadlineFor = (a: DaemonPtyAdapter): number | undefined =>
      generationDeadline(a, adapterSet.current, cap)
    const listings = await listPerGeneration(
      polled,
      (a) => {
        const deadlineMs = deadlineFor(a)
        return a.readSessions(deadlineMs === undefined ? undefined : { deadlineMs })
      },
      deadlineFor
    )
    for (const listing of listings) {
      const owned = [...remaining].filter(([, target]) => target.adapter === listing.source)
      if (listing.contact === 'unverifiable') {
        // Why not re-polled: every later poll would pay the deadline again for no new answer.
        polled = polled.filter((adapter) => adapter !== listing.source)
        for (const [key, target] of owned) {
          remaining.delete(key)
          unverified.set(key, target)
        }
        continue
      }
      const present = new Set(
        listing.contact === 'live'
          ? listing.items.map((s) => identityKey(listing.source.protocolVersion, s))
          : []
      )
      for (const [key] of owned) {
        if (!present.has(key)) {
          remaining.delete(key)
        }
      }
    }
  }
  const stillHeldIds = new Set(
    [...remaining.values(), ...unverified.values()].map((t) => t.sessionId)
  )
  const killedSessionIds = [
    ...new Set(
      [...initial]
        .filter(([key]) => !remaining.has(key) && !unverified.has(key))
        .map(([, target]) => target.sessionId)
    )
  ].filter((sessionId) => !stillHeldIds.has(sessionId))
  return {
    killedCount: initial.size - remaining.size - unverified.size,
    remainingCount: remaining.size,
    unverifiedCount: unverified.size,
    unreachedVersionCount,
    killedSessionIds
  }
}
