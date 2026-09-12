import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION } from '../../shared/pty-ownership-bridge-contract'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD } from '../../shared/pty-ownership-transfer-runtime-methods'
import { bindOutgoingOrcadSource } from './orcad-outgoing-source-binding'
import { bindOrcadCapturedRuntimeRequest } from './orcad-captured-runtime-request'

const sourceFlags = [
  'liveTransfer',
  'inputDeduplication',
  'destinationOutput',
  'destinationControl',
  'authoritativeExit',
  'postCommitReplay',
  'reconnectRekey',
  'statusQuery'
] as const
const sourceVersions = [
  'preparationShutdownGuardVersion',
  'transferGraceGuardVersion',
  'transferLifecycleGuardVersion',
  'destinationDelegationVersion',
  'captureBoundaryVersion',
  'captureSelectionVersion',
  'captureSelectionRecoveryVersion',
  'sourceRetirementVersion',
  'sourceRetirementBoundaryVersion',
  'sourceRetirementRecoveryVersion'
] as const
const destinationVersions = [
  'version',
  'catalogPublication',
  'catalogActivation',
  'sourceRetirement',
  'sourceRetirementRecovery',
  'catalogMigrationVersion',
  'sessionTerminalIdentity'
] as const

/** Compatibility observation only; callers retain lifecycle locks and recheck each later phase. */
export async function assertOrcadLiveMigrationPreflight(options: {
  pairingCode: string
  targetId: string
  identities: readonly unknown[]
  signal: AbortSignal
  assertAuthority: () => void
}): Promise<void> {
  options.signal.throwIfAborted()
  options.assertAuthority()
  const identities = options.identities.map(parsePtyOwnershipTransferWireIdentity)
  if (
    !identities.length ||
    new Set(identities.map(({ destinationRuntimeId }) => destinationRuntimeId)).size !== 1 ||
    new Set(identities.map(({ terminalId }) => terminalId)).size !== identities.length ||
    new Set(identities.map(({ bridgeId }) => bridgeId)).size !== identities.length
  ) {
    throw new Error('orcad_live_migration_preflight_identity_mismatch')
  }
  const sources = identities.map((identity) =>
    bindOutgoingOrcadSource({
      identity,
      ptyId: toAppSshPtyId(options.targetId, identity.terminalId),
      sourceSshTargetId: options.targetId,
      signal: options.signal,
      assertAuthority: options.assertAuthority
    })
  )
  const assertCurrent = () => {
    options.signal.throwIfAborted()
    options.assertAuthority()
    for (const source of sources) {
      source.assertSource()
    }
  }
  assertCurrent()
  const providers = [...new Set(sources.map(({ provider }) => provider))]
  if (
    providers.some(
      (provider) =>
        typeof provider.getOwnershipBridgeCapabilities !== 'function' ||
        typeof provider.drainOutgoingSourceControls !== 'function' ||
        typeof provider.fenceOutgoingCatalogCreation !== 'function'
    )
  ) {
    throw new Error('orcad_live_migration_source_preflight_unsupported')
  }
  for (const provider of providers) {
    assertCurrent()
    const capabilities = await provider.getOwnershipBridgeCapabilities!({ signal: options.signal })
    assertCurrent()
    if (
      !capabilities ||
      !Array.isArray(capabilities.protocolVersions) ||
      !capabilities.protocolVersions.includes(PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION) ||
      sourceFlags.some((key) => capabilities[key] !== true) ||
      sourceVersions.some((key) => capabilities[key] !== 1)
    ) {
      throw new Error('orcad_live_migration_source_preflight_unsupported')
    }
  }
  const request = bindOrcadCapturedRuntimeRequest({
    pairingCode: options.pairingCode,
    runtimeId: identities[0].destinationRuntimeId,
    signal: options.signal,
    assertAuthority: assertCurrent,
    errorPrefix: 'orcad_live_migration_preflight'
  })
  const support = await request(PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD, { version: 1 })
  assertCurrent()
  if (
    !support ||
    typeof support !== 'object' ||
    Array.isArray(support) ||
    destinationVersions.some((key) => (support as Record<string, unknown>)[key] !== 1)
  ) {
    throw new Error('orcad_live_migration_destination_preflight_unsupported')
  }
}
