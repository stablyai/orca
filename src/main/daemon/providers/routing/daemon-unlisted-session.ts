import { readdirSync } from 'node:fs'
import { isHoldingForNewerProtocolDaemon } from './daemon-newer-protocol-hold'
import { legacyDaemonProcessMayBeAlive } from '../../launch/daemon-legacy-process-liveness'
import type { DaemonClient } from '../../transport/client/daemon-client'
import type { HistoryReader } from '../../history/restoration/history-reader'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS } from '../../protocol/daemon-protocol-version'
import type { ListSessionsResult } from '../../protocol/daemon-rpc-contract'

export type SessionListingDaemon = {
  readonly protocolVersion: number
  listsSession(id: string): Promise<boolean | null>
}

/**
 * Whether any daemon sharing the history dir may still run the session. A daemon Orca holds no
 * adapter for (held for a newer protocol, or an older one whose socket failed) cannot answer, and
 * silence is never absence.
 */
export async function mayAnyDaemonRunSession(
  id: string,
  runtimeDir: string | null,
  daemons: readonly SessionListingDaemon[]
): Promise<boolean> {
  if (runtimeDir === null || isHoldingForNewerProtocolDaemon()) {
    return true
  }
  const asked = new Set(daemons.map((daemon) => daemon.protocolVersion))
  if (
    PREVIOUS_DAEMON_PROTOCOL_VERSIONS.some(
      (version) => !asked.has(version) && legacyDaemonProcessMayBeAlive(runtimeDir, version)
    )
  ) {
    return true
  }
  const listings = await Promise.all(daemons.map((daemon) => daemon.listsSession(id)))
  return listings.some((listed) => listed !== false)
}

/**
 * Whether a daemon outside `asked` may still run sessions: one held for a newer protocol, or an older one
 * whose process may be alive. Their sessions are in no inventory Orca can read, so absence proves nothing.
 */
export function mayUnaskedDaemonRunSessions(
  runtimeDir: string | null,
  asked: ReadonlySet<number>
): boolean {
  if (runtimeDir === null || isHoldingForNewerProtocolDaemon()) {
    return true
  }
  let present: string[]
  try {
    // One directory read instead of a failed open per older protocol; only a present pid file can name a live daemon.
    present = readdirSync(runtimeDir)
  } catch {
    return true
  }
  const older = new Set<number>(PREVIOUS_DAEMON_PROTOCOL_VERSIONS)
  return present.some((name) => {
    const version = Number(LEGACY_PID_FILE.exec(name)?.[1])
    return (
      older.has(version) &&
      !asked.has(version) &&
      legacyDaemonProcessMayBeAlive(runtimeDir, version)
    )
  })
}

const LEGACY_PID_FILE = /^daemon-v(\d+)\.pid$/

/** Whether a daemon lists the session at all, alive or not; null when it can't answer. */
export async function readDaemonSessionListing(
  client: Pick<DaemonClient, 'isConnected' | 'request'>,
  id: string,
  timeoutMs: number
): Promise<boolean | null> {
  // Never start or respawn a daemon just to list it: unconnected cannot answer.
  if (!client.isConnected()) {
    return null
  }
  try {
    const { sessions } = await client.request<ListSessionsResult>(
      'listSessions',
      undefined,
      timeoutMs
    )
    return sessions.some((session) => session.sessionId === id)
  } catch {
    return null
  }
}

/** A close found no session: true when its history is unended and no daemon may still run it. */
export async function isUnlistedLostSession(
  id: string,
  historyReader: Pick<HistoryReader, 'probeRestorableHistory'> | null,
  runtimeDir: string | null,
  daemons: readonly SessionListingDaemon[]
): Promise<boolean> {
  return (
    historyReader?.probeRestorableHistory(id).status === 'restorable' &&
    !(await mayAnyDaemonRunSession(id, runtimeDir, daemons))
  )
}
