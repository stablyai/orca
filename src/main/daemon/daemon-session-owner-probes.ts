import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { sameDaemonIncarnation } from './daemon-session-route'

export type DaemonSessionOwnerProbe = {
  owner: DaemonPtyAdapter
  result: boolean | null
  incarnation: DaemonEndpointIdentity | null
}

export async function probeDaemonSessionOwner(
  owner: DaemonPtyAdapter,
  sessionId: string
): Promise<DaemonSessionOwnerProbe> {
  const before = owner.getLastAuthenticatedDaemonIdentity()
  try {
    const result = await owner.probePtyLiveness(sessionId)
    const incarnation = owner.getLastAuthenticatedDaemonIdentity()
    return {
      owner,
      result: before && !sameDaemonIncarnation(before, incarnation) ? null : result,
      incarnation
    }
  } catch {
    return {
      owner,
      result: null,
      incarnation: owner.getLastAuthenticatedDaemonIdentity()
    }
  }
}

export function probeDaemonSessionOwnerSync(
  owner: DaemonPtyAdapter,
  sessionId: string
): DaemonSessionOwnerProbe {
  const before = owner.getLastAuthenticatedDaemonIdentity()
  try {
    const result = owner.hasPty(sessionId)
    const incarnation = owner.getLastAuthenticatedDaemonIdentity()
    return {
      owner,
      result: before && !sameDaemonIncarnation(before, incarnation) ? null : result,
      incarnation
    }
  } catch {
    return { owner, result: null, incarnation: owner.getLastAuthenticatedDaemonIdentity() }
  }
}
