import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { parseOrcadTerminalLayoutAdmission } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'

/** Caller holds installed-profile authority; saved capture alone never authorizes retirement. */
export function bindOrcadLiveRetirementCapture(options: {
  profileDirectory: string
  identity: unknown
  catalogAdmission: unknown
  destinationEnvironmentId: string
  signal: AbortSignal
  assertAuthority: () => void
}) {
  const identity = parsePtyOwnershipTransferWireIdentity(options.identity)
  const catalog = parseOrcadTerminalLayoutAdmission(options.catalogAdmission)
  const captures = new OrcadOutgoingCaptureStore(options.profileDirectory)
  options.signal.throwIfAborted()
  options.assertAuthority()
  const capture = captures.read(identity)
  if (
    !capture ||
    capture.version !== 2 ||
    capture.destinationEnvironmentId !== options.destinationEnvironmentId ||
    capture.sourceSshTargetId !== catalog.manifest.source.sshTargetId ||
    capture.sourceSshTargetGeneration !== catalog.manifest.source.sshTargetGeneration ||
    serializeOrcadMigrationValue(capture.catalogAdmission) !== serializeOrcadMigrationValue(catalog)
  ) {
    throw new Error('orcad_live_retirement_capture_binding_mismatch')
  }
  const expected = serializeOrcadMigrationValue(capture)
  const assertCurrent = () => {
    options.signal.throwIfAborted()
    options.assertAuthority()
    if (serializeOrcadMigrationValue(captures.read(identity)) !== expected) {
      throw new Error('orcad_live_retirement_capture_changed')
    }
  }
  assertCurrent()
  return { capture: structuredClone(capture), assertCurrent }
}
