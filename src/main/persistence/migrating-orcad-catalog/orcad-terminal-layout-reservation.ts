import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'
import { samePtyOwnershipTransferPublicationReceipt } from '../../../shared/pty-ownership-transfer-receipt-validation'
import { samePtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { PtyOwnershipTransferDestinationPublicationRequest } from '../../../shared/pty-ownership-transfer-destination-adapter'
import {
  inspectReservedPtyOwnershipTransferLayoutAdmission,
  type ReservedPtyOwnershipTransferLayout
} from '../loading-store/pty-ownership-transfer-reserved-layout-admission'
import { parsePtyOwnershipTransferDestinationFile } from '../pty-ownership-transfer/pty-ownership-transfer-destination-file'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS } from '../../../shared/pty-ownership-transfer-destination-adapter'

/** Derives topology from durable intent, never from publication caller-supplied layout fields. */
export function resolveOrcadTerminalLayoutReservation(
  value: unknown,
  request: Pick<
    PtyOwnershipTransferDestinationPublicationRequest,
    'identity' | 'surfaceBinding' | 'publicationReceipt'
  >
): ReservedPtyOwnershipTransferLayout | null {
  const record = parsePtyOwnershipTransferDestinationFile(
    value,
    PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS
  )
  if (!samePtyOwnershipTransferIdentity(record.journal, request.identity)) {
    throw new Error('orcad_terminal_layout_reservation_identity_conflict')
  }
  const admission = record.catalogAdmission
  if (!admission) {
    return null
  }
  if (
    (record.journal.phase !== 'committed' && record.journal.phase !== 'published') ||
    !record.publicationIntent ||
    !samePtyOwnershipTransferPublicationReceipt(
      record.publicationIntent,
      request.publicationReceipt
    ) ||
    !record.surfaceBinding ||
    !samePtyOwnershipTransferSurfaceBinding(record.surfaceBinding, request.surfaceBinding)
  ) {
    throw new Error('orcad_terminal_layout_reservation_publication_conflict')
  }
  const scope = parseWorkspaceKey(record.surfaceBinding.workspaceKey)!
  const worktreeId =
    scope.type === 'folder' ? `folder:${scope.folderWorkspaceId}` : scope.worktreeId
  const session = admission.manifest.payload.dormantState!.workspaceSession!
  const reservation: ReservedPtyOwnershipTransferLayout = {
    worktreeId,
    tab: session.tabsByWorktree[worktreeId].find((tab) => tab.id === record.surfaceBinding!.tabId)!,
    layout: session.terminalLayoutsByTabId[record.surfaceBinding.tabId],
    bindings: admission.bindings.map(({ identity, surfaceBinding }) => ({
      worktreeId,
      tabId: surfaceBinding.tabId,
      leafId: surfaceBinding.leafId,
      ptyId: surfaceBinding.ptyId,
      incarnationId: identity.incarnationId
    }))
  }
  const binding = reservation.bindings.find(
    (entry) => entry.leafId === request.surfaceBinding.leafId
  )!
  if (
    inspectReservedPtyOwnershipTransferLayoutAdmission(
      getDefaultWorkspaceSession(),
      binding,
      reservation
    ) !== 'absent'
  ) {
    throw new Error('orcad_terminal_layout_reservation_invalid')
  }
  // Sibling membership is not evidence that its terminal has published.
  return structuredClone(reservation)
}
