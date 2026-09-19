import { randomBytes, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import {
  parsePtyOwnershipTransferSurfaceBinding,
  samePtyOwnershipTransferSurfaceBinding
} from '../../shared/pty-ownership-transfer-surface-binding'
import { getSshPtyProvider } from '../ipc/pty/provider/registry'
import { requireManagedOrcadTargetStore } from './orcad-managed-runtime-context'
import { OrcadOutgoingPreparationStore } from './orcad-outgoing-preparation-store'
import {
  OrcadOutgoingCaptureStore,
  parseOrcadOutgoingTargetBinding
} from './orcad-outgoing-capture-store'
import { withOutgoingOrcadAuthority } from './orcad-outgoing-authority'
import { bindOutgoingOrcadSource } from './orcad-outgoing-source-binding'
import { discoverOutgoingOrcadSourceEndpoint } from './orcad-outgoing-source-endpoint'

/** Creates retry authority only; it does not prepare or fence the source PTY. */
export async function createOutgoingOrcadPreparation(
  userDataPath: string,
  args: {
    selector: string
    ptyId: string
    surfaceBinding: unknown
    signal: AbortSignal
    assertSurface?: () => void
  }
) {
  args.signal.throwIfAborted()
  args.assertSurface?.()
  const ptyId = args.ptyId
  const route = parseAppSshPtyId(ptyId)
  const surfaceBinding = parsePtyOwnershipTransferSurfaceBinding(args.surfaceBinding)
  if (
    !route ||
    surfaceBinding.executionHostId !== 'local' ||
    surfaceBinding.ptyId !== route.relayPtyId
  ) {
    throw new Error('orcad_outgoing_capture_source_route_invalid')
  }
  const environment = resolveEnvironment(userDataPath, args.selector)
  const target = requireManagedOrcadTargetStore().getTarget(route.connectionId)
  const source = getSshPtyProvider(route.connectionId)?.getOwnershipTransferSourceIdentity?.(ptyId)
  if (!target || !source || !environment.runtimeId) {
    throw new Error('orcad_outgoing_capture_source_unavailable')
  }
  const identity = parsePtyOwnershipTransferWireIdentity({
    ...source,
    bridgeId: randomUUID(),
    destinationRuntimeId: environment.runtimeId
  })
  const binding = {
    version: 1,
    identity,
    destinationEnvironmentId: environment.id,
    sourceSshTargetId: target.id,
    sourceSshTargetGeneration: target.generation
  }
  return withOutgoingOrcadAuthority(
    userDataPath,
    { binding, signal: args.signal, assertEvidence: () => args.assertSurface?.() },
    ({ assertAuthority }) =>
      createPreparationUnderAuthority(userDataPath, {
        binding: parseOrcadOutgoingTargetBinding(binding),
        ptyId,
        surfaceBinding,
        signal: args.signal,
        assertAuthority
      })
  )
}

/** Caller holds lifecycle locks and asserts the admitted catalog remains current. */
export async function createOutgoingOrcadCatalogPreparationUnderAuthority(
  userDataPath: string,
  args: {
    binding: unknown
    ptyId: string
    surfaceBinding: unknown
    signal: AbortSignal
    assertAuthority: () => void
  }
) {
  args.signal.throwIfAborted()
  args.assertAuthority()
  const binding = parseOrcadOutgoingTargetBinding(args.binding)
  const surfaceBinding = parsePtyOwnershipTransferSurfaceBinding(args.surfaceBinding)
  if (
    binding.version !== 2 ||
    !binding.catalogAdmission?.bindings.some(
      (entry) =>
        samePtyOwnershipTransferIdentity(entry.identity, binding.identity) &&
        samePtyOwnershipTransferSurfaceBinding(entry.surfaceBinding, surfaceBinding)
    )
  ) {
    throw new Error('orcad_outgoing_catalog_identity_mismatch')
  }
  return createPreparationUnderAuthority(userDataPath, { ...args, binding, surfaceBinding })
}

async function createPreparationUnderAuthority(
  userDataPath: string,
  args: {
    binding: ReturnType<typeof parseOrcadOutgoingTargetBinding>
    ptyId: string
    surfaceBinding: ReturnType<typeof parsePtyOwnershipTransferSurfaceBinding>
    signal: AbortSignal
    assertAuthority: () => void
  }
) {
  const { binding, ptyId, surfaceBinding, assertAuthority } = args
  const { identity, sourceSshTargetId } = binding
  const preparations = new OrcadOutgoingPreparationStore(userDataPath)
  const captures = new OrcadOutgoingCaptureStore(userDataPath)
  const pinned = bindOutgoingOrcadSource({
    identity,
    ptyId,
    sourceSshTargetId,
    signal: args.signal,
    assertAuthority
  })
  const pending = preparations
    .list()
    .filter(
      (entry) =>
        entry.sourceSshTargetId === sourceSshTargetId &&
        entry.identity.terminalId === identity.terminalId
    )
  const candidates = captures
    .list()
    .filter(
      (entry) =>
        entry.sourceSshTargetId === sourceSshTargetId &&
        entry.identity.terminalId === identity.terminalId
    )
  const existing = pending[0]
  if (
    pending.length > 1 ||
    candidates.some((entry) => entry.identity.bridgeId !== existing?.identity.bridgeId)
  ) {
    throw new Error('orcad_outgoing_preparation_recovery_required')
  }
  if (existing) {
    if (
      existing.version !== binding.version ||
      !isDeepStrictEqual(existing.catalogAdmission, binding.catalogAdmission) ||
      !samePtyOwnershipTransferIdentity(existing.identity, {
        ...identity,
        bridgeId: binding.version === 1 ? existing.identity.bridgeId : identity.bridgeId
      }) ||
      existing.destinationEnvironmentId !== binding.destinationEnvironmentId ||
      existing.sourceSshTargetGeneration !== binding.sourceSshTargetGeneration ||
      !samePtyOwnershipTransferSurfaceBinding(existing.surfaceBinding, surfaceBinding)
    ) {
      throw new Error('orcad_outgoing_preparation_recovery_required')
    }
    pinned.assertSource()
    return preparations.persistForSource(existing, pinned)
  }
  const endpoint = await discoverOutgoingOrcadSourceEndpoint({
    identity,
    ptyId,
    sourceSshTargetId,
    signal: args.signal,
    assertAuthority
  })
  pinned.assertSource()
  return preparations.persistForSource(
    {
      ...binding,
      kind: 'preparation',
      surfaceBinding,
      source: {
        version: 1,
        endpoint: endpoint.endpoint,
        incumbentVersion: endpoint.incumbentVersion,
        endpointCredential: endpoint.endpointCredential,
        proof: { version: 1, ...identity, credential: randomBytes(32).toString('hex') }
      }
    },
    pinned
  )
}
