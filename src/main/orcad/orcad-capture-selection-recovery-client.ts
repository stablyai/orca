import { parsePtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge-validation'
import { parsePtyOwnershipCaptureBaseline } from '../../shared/pty-ownership-capture-baseline'
import { PTY_OWNERSHIP_CAPTURE_METHODS } from '../../shared/pty-ownership-capture-wire'
import { parsePtyOwnershipTransferDestinationProof } from '../../shared/pty-ownership-transfer-destination-claim'
import type {
  PtyOwnershipTransferRequestTransport,
  PtyOwnershipTransferRequestOptions
} from '../providers/ssh-pty-ownership-transfer-client'

export async function recoverOrcadSourceCaptureSelection(
  transport: PtyOwnershipTransferRequestTransport,
  proof: unknown,
  value: unknown,
  options?: PtyOwnershipTransferRequestOptions
) {
  const request = parsePtyOwnershipTransferDestinationProof(proof)
  const baseline = parsePtyOwnershipCaptureBaseline(value, request)
  options?.signal?.throwIfAborted()
  const capabilities = parsePtyOwnershipBridgeCapabilities(
    await transport('pty.getOwnershipBridgeCapabilities', {}, options)
  )
  options?.signal?.throwIfAborted()
  if (capabilities?.captureSelectionRecoveryVersion !== 1) {
    throw new Error('orcad_capture_selection_recovery_unsupported')
  }
  const result = await transport(
    PTY_OWNERSHIP_CAPTURE_METHODS.recoverSelection,
    { version: 1, proof: request, baseline },
    options
  )
  options?.signal?.throwIfAborted()
  const record = result as Record<string, unknown> | null
  if (
    !record ||
    record.version !== 1 ||
    JSON.stringify(parsePtyOwnershipCaptureBaseline(record.baseline, request)) !==
      JSON.stringify(baseline)
  ) {
    throw new Error('orcad_capture_selection_recovery_reply_mismatch')
  }
  return baseline
}
