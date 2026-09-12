import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'
import { samePtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import type { PtyOwnershipTransferPrepareResult } from '../../../shared/pty-ownership-transfer-wire'
import {
  parseOrcadTerminalLayoutAdmission,
  type OrcadTerminalLayoutAdmission
} from '../migrating-orcad-catalog/orcad-terminal-layout-admission'
import type { PtyOwnershipTransferDestinationFileStore } from './pty-ownership-transfer-destination-file-store'
import { parsePtyOwnershipTransferDelegatedSource } from './pty-ownership-transfer-delegated-source'

/** The caller supplies the result only after its authenticated source status/model checks. */
export function bindCapturedPtyCatalogAdmission(args: {
  value: unknown
  result: PtyOwnershipTransferPrepareResult
  source: unknown
  destinationStore: PtyOwnershipTransferDestinationFileStore
  prepareCatalog: (
    manifest: OrcadTerminalLayoutAdmission['manifest'],
    bindings: OrcadTerminalLayoutAdmission['bindings']
  ) => OrcadTerminalLayoutAdmission
  assertActive: () => void
}): void {
  const proposed = parseOrcadTerminalLayoutAdmission(args.value)
  const source = parsePtyOwnershipTransferDelegatedSource(args.source, args.result)
  const binding = proposed.bindings.find((entry) =>
    samePtyOwnershipTransferIdentity(entry.identity, args.result)
  )
  if (
    !binding ||
    !args.result.surfacePublication ||
    !samePtyOwnershipTransferSurfaceBinding(
      binding.surfaceBinding,
      args.result.surfacePublication.surfaceBinding
    )
  ) {
    throw new Error('pty_ownership_transfer_captured_catalog_source_conflict')
  }
  args.assertActive()
  const admitted = args.prepareCatalog(proposed.manifest, proposed.bindings)
  args.assertActive()
  args.destinationStore.prepare(args.result, args.result.sourceOutputEndSeq)
  args.destinationStore.bindDelegatedSource(args.result, source)
  args.destinationStore.surface.bindCatalogAdmission(args.result, admitted)
}
