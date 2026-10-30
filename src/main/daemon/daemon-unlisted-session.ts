import { isHoldingForNewerProtocolDaemon } from './daemon-newer-protocol-hold'
import { legacyDaemonProcessMayBeAlive } from './daemon-legacy-process-liveness'
import type { DaemonClient } from './client'
import type { HistoryReader } from './history-reader'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS, type ListSessionsResult } from './types'

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
