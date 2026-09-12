import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'
import { getProviderForPty, getSshPtyProvider } from '../ipc/pty/provider/registry'

export function bindOutgoingOrcadSource(options: {
  identity: PtyOwnershipTransferWireIdentity
  ptyId: string
  sourceSshTargetId: string
  signal: AbortSignal
  assertAuthority: () => void
}) {
  const source = bindOutgoingOrcadIncumbent(options)
  source.assertSource()
  return source
}

/** Retains transport authority without reopening ordinary client control dispatch. */
export function bindOutgoingOrcadIncumbent(options: Parameters<typeof bindOutgoingOrcadSource>[0]) {
  return bindOutgoingOrcadTransport(options, 'live')
}

/** Retained release authority is not evidence of host retirement or cancellation. */
export function bindReleasedOutgoingOrcadIncumbent(
  options: Parameters<typeof bindOutgoingOrcadSource>[0]
) {
  return bindOutgoingOrcadTransport(options, 'released')
}

function bindOutgoingOrcadTransport(
  options: Parameters<typeof bindOutgoingOrcadSource>[0],
  authority: 'live' | 'released'
) {
  const identity = parsePtyOwnershipTransferWireIdentity(options.identity)
  const ptyId = options.ptyId
  const parsed = parseAppSshPtyId(ptyId)
  if (
    !parsed ||
    parsed.connectionId !== options.sourceSshTargetId ||
    parsed.relayPtyId !== identity.terminalId
  ) {
    throw new Error('orcad_outgoing_capture_source_route_invalid')
  }
  const provider = getSshPtyProvider(parsed.connectionId)
  const providerGeneration = (provider as { providerGeneration?: number } | undefined)
    ?.providerGeneration
  const request = provider?.requestHostRpc?.bind(provider)
  if (
    !provider ||
    !request ||
    !Number.isSafeInteger(providerGeneration) ||
    providerGeneration! <= 0
  ) {
    throw new Error('orcad_outgoing_capture_source_unavailable')
  }
  const assertIncumbent = () => {
    options.signal.throwIfAborted()
    options.assertAuthority()
    const source =
      authority === 'live' ? provider.getOwnershipTransferSourceIdentity?.(ptyId) : undefined
    const matchesIdentity =
      authority === 'released'
        ? provider.isOutgoingSourceControlReleased?.(ptyId, identity) === true
        : source &&
          source.terminalId === identity.terminalId &&
          source.incarnationId === identity.incarnationId &&
          source.ownerLease === identity.ownerLease &&
          source.sourceOwnerGeneration === identity.sourceOwnerGeneration
    if (
      !isPtyOwnershipTransferMutationEnabled() ||
      getSshPtyProvider(parsed.connectionId) !== provider ||
      (provider as { providerGeneration?: number }).providerGeneration !== providerGeneration ||
      !matchesIdentity
    ) {
      throw new Error('orcad_outgoing_capture_source_authority_changed')
    }
  }
  const assertSource = () => {
    assertIncumbent()
    if (getProviderForPty(ptyId) !== provider) {
      throw new Error('orcad_outgoing_capture_source_authority_changed')
    }
  }
  assertIncumbent()
  return {
    identity,
    ptyId,
    provider,
    providerGeneration: providerGeneration!,
    request,
    assertIncumbent,
    assertSource
  }
}
