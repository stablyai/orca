import type { PtyOwnershipCaptureBoundary } from '../../shared/pty-ownership-capture-boundary'
import { getSshPtyAcceptedSourceCheckpoints } from '../ipc/ssh-pty-output-intake-registry'
import type { SshPtyAcceptedSourceCheckpoint } from '../ipc/ssh-pty-output-source-obligations'

export function requireSshPtyCaptureModelCheckpoint(
  boundary: PtyOwnershipCaptureBoundary,
  route: Readonly<{ ptyId: string; providerGeneration: number }>
): SshPtyAcceptedSourceCheckpoint {
  const candidates = getSshPtyAcceptedSourceCheckpoints(route.providerGeneration).filter(
    (checkpoint) => checkpoint.id === route.ptyId
  )
  const checkpoint = candidates[0]
  const delivery = boundary.delivery
  if (
    candidates.length !== 1 ||
    !checkpoint ||
    checkpoint.providerGeneration !== route.providerGeneration ||
    checkpoint.clientGeneration !== delivery.clientGeneration ||
    checkpoint.ownerGeneration !== delivery.ownerGeneration ||
    checkpoint.ptyIncarnation !== delivery.ptyIncarnation ||
    checkpoint.deliveryToken !== delivery.deliveryToken ||
    checkpoint.acceptedSourceEndSu !== delivery.receivedEndSu
  ) {
    throw new Error('pty_ownership_capture_model_checkpoint_unavailable')
  }
  // App PTY ids/provider generations are local; delivery token/generations bind the host stream.
  return Object.freeze({ ...checkpoint })
}
