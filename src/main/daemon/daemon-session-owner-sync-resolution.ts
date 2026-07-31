import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { probeDaemonSessionOwnerSync } from './daemon-session-owner-probes'
import {
  DaemonSessionGoneError,
  DaemonSessionOwnerUnknownError,
  type DaemonSessionRoute,
  DaemonSessionUnavailableError
} from './daemon-session-route'

type ResolveDaemonSessionOwnerSyncOptions = {
  sessionId: string
  route: DaemonSessionRoute | undefined
  discoveryIncomplete: boolean
  adapters: readonly DaemonPtyAdapter[]
  transfer: (owner: DaemonPtyAdapter, incarnation: DaemonEndpointIdentity | null) => void
  recordAmbiguous: (
    candidates: ReadonlyMap<DaemonPtyAdapter, DaemonEndpointIdentity | null>
  ) => void
}

export function resolveDaemonSessionOwnerSync({
  sessionId,
  route,
  discoveryIncomplete,
  adapters,
  transfer,
  recordAmbiguous
}: ResolveDaemonSessionOwnerSyncOptions): DaemonPtyAdapter {
  if (route?.state === 'owned') {
    return route.owner
  }
  if (route?.state === 'unavailable') {
    throw new DaemonSessionUnavailableError(sessionId)
  }
  if (route?.state === 'ambiguous') {
    throw new DaemonSessionOwnerUnknownError(sessionId)
  }
  const results = adapters.map((owner) => probeDaemonSessionOwnerSync(owner, sessionId))
  const owners = results.filter(({ result }) => result === true)
  if (results.some(({ result }) => result === null)) {
    throw new DaemonSessionOwnerUnknownError(sessionId)
  }
  if (owners.length === 1) {
    transfer(owners[0].owner, owners[0].incarnation)
    return owners[0].owner
  }
  if (owners.length > 1) {
    recordAmbiguous(new Map(owners.map(({ owner, incarnation }) => [owner, incarnation])))
    throw new DaemonSessionOwnerUnknownError(sessionId)
  }
  if (discoveryIncomplete) {
    throw new DaemonSessionOwnerUnknownError(sessionId)
  }
  throw new DaemonSessionGoneError(sessionId)
}
