import { isPtyIncarnationId } from '../../../../shared/pty-incarnation'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

// Why: post-spawn write/resize/kill calls carry only the PTY ID; map it to the host that runs it so ops route to the right provider.
export const ptyOwnership = new Map<string, ExecutionHostId>()
export const ptyIncarnationById = new Map<string, string>()

export function isCurrentPtyExit(payload: { id: string; incarnationId?: string }): boolean {
  const current = ptyIncarnationById.get(payload.id)
  return !current || payload.incarnationId === current
}

export function deletePtyOwnership(id: string): void {
  ptyOwnership.delete(id)
}

export function setPtyOwnership(id: string, hostId: ExecutionHostId): void {
  ptyOwnership.set(id, hostId)
}

/** An adopted PTY that names no SSH target keeps the host already recorded for its id. */
export function setAdoptedPtyOwnership(id: string, connectionId: string | null | undefined): void {
  ptyOwnership.set(
    id,
    connectionId
      ? toSshExecutionHostId(connectionId)
      : (ptyOwnership.get(id) ?? LOCAL_EXECUTION_HOST_ID)
  )
}

export function restorePtyIncarnation(id: string, incarnationId: string): void {
  if (!isPtyIncarnationId(incarnationId)) {
    throw new Error('Invalid PTY incarnation')
  }
  ptyIncarnationById.set(id, incarnationId)
}

export function getPtyIdsForHost(hostId: ExecutionHostId): string[] {
  const ids: string[] = []
  for (const [ptyId, ownerHostId] of ptyOwnership) {
    if (ownerHostId === hostId) {
      ids.push(ptyId)
    }
  }
  return ids
}

export function getPtyIdsForConnection(connectionId: string): string[] {
  return getPtyIdsForHost(toSshExecutionHostId(connectionId))
}
