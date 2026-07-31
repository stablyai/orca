import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { probeDaemonSessionOwner } from './daemon-session-owner-probes'
import {
  DaemonSessionGoneError,
  DaemonSessionOwnerUnknownError,
  sameDaemonIncarnation
} from './daemon-session-route'

type ResolveDaemonSessionOwnerOptions = {
  sessionId: string
  candidates: readonly DaemonPtyAdapter[]
  expectedIncarnations?: ReadonlyMap<DaemonPtyAdapter, DaemonEndpointIdentity | null>
  discoveryComplete: boolean
  transfer: (owner: DaemonPtyAdapter, incarnation: DaemonEndpointIdentity | null) => void
  recordAmbiguous: (
    candidates: ReadonlyMap<DaemonPtyAdapter, DaemonEndpointIdentity | null>
  ) => void
}

export async function resolveDaemonSessionOwner({
  sessionId,
  candidates,
  expectedIncarnations,
  discoveryComplete,
  transfer,
  recordAmbiguous
}: ResolveDaemonSessionOwnerOptions): Promise<DaemonPtyAdapter> {
  const probed = await Promise.all(
    candidates.map((owner) => probeDaemonSessionOwner(owner, sessionId))
  )
  const results = probed.map((result) =>
    sameDaemonIncarnation(result.incarnation, result.owner.getLastAuthenticatedDaemonIdentity()) &&
    (!expectedIncarnations?.has(result.owner) ||
      sameDaemonIncarnation(expectedIncarnations.get(result.owner) ?? null, result.incarnation))
      ? result
      : { ...result, result: null }
  )
  const owners = results.filter(({ result }) => result === true)
  if (owners.length === 1 && results.every(({ result }) => result !== null)) {
    transfer(owners[0].owner, owners[0].incarnation)
    return owners[0].owner
  }
  if (owners.length > 1) {
    recordAmbiguous(new Map(owners.map(({ owner, incarnation }) => [owner, incarnation])))
  }
  if (owners.length === 0 && results.every(({ result }) => result === false) && discoveryComplete) {
    throw new DaemonSessionGoneError(sessionId)
  }
  throw new DaemonSessionOwnerUnknownError(sessionId)
}
