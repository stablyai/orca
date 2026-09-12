import { isPtyIncarnationId } from '../../../../shared/pty-incarnation'
import { assertPtyRouteAdmissionAllowed } from './pty-route-refusal'

// Why: post-spawn write/resize/kill calls carry only the PTY ID; map it to its connectionId so ops route to the right provider.
export const ptyOwnership = new Map<string, string | null>()
export const ptyIncarnationById = new Map<string, string>()

export function isCurrentPtyExit(payload: { id: string; incarnationId?: string }): boolean {
  const current = ptyIncarnationById.get(payload.id)
  return !current || payload.incarnationId === current
}

export function deletePtyOwnership(id: string): void {
  ptyOwnership.delete(id)
}

export function setPtyOwnership(id: string, connectionId: string | null): void {
  assertPtyRouteAdmissionAllowed(id)
  ptyOwnership.set(id, connectionId)
}

export function restorePtyIncarnation(id: string, incarnationId: string): void {
  assertPtyRouteAdmissionAllowed(id)
  if (!isPtyIncarnationId(incarnationId)) {
    throw new Error('Invalid PTY incarnation')
  }
  ptyIncarnationById.set(id, incarnationId)
}

export function getPtyIdsForConnection(connectionId: string): string[] {
  const ids: string[] = []
  for (const [ptyId, connId] of ptyOwnership) {
    if (connId === connectionId) {
      ids.push(ptyId)
    }
  }
  return ids
}
