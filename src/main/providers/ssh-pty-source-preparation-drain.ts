import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type { IPtyProvider } from './types'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

export type SshPtyControlDrain = {
  identity: unknown
  surfaceBinding?: unknown
  providerGeneration: number
  signal: AbortSignal
}

export async function drainSshPtyControls(
  provider: Pick<IPtyProvider, 'getOwnershipTransferSourceIdentity'> & {
    providerGeneration: number
  },
  mux: SshChannelMultiplexer,
  value: SshPtyControlDrain
): Promise<void> {
  const identity = parsePtyOwnershipTransferWireIdentity(value.identity)
  const assertCurrent = () => {
    value.signal.throwIfAborted()
    const source = provider.getOwnershipTransferSourceIdentity?.(identity.terminalId)
    if (
      !isPtyOwnershipTransferMutationEnabled() ||
      mux.isDisposed() ||
      !Number.isSafeInteger(value.providerGeneration) ||
      value.providerGeneration <= 0 ||
      provider.providerGeneration !== value.providerGeneration ||
      parseAppSshPtyId(identity.terminalId) ||
      !source ||
      source.terminalId !== identity.terminalId ||
      source.incarnationId !== identity.incarnationId ||
      source.ownerLease !== identity.ownerLease ||
      source.sourceOwnerGeneration !== identity.sourceOwnerGeneration
    ) {
      throw new Error('orcad_source_preparation_drain_authority_changed')
    }
  }
  assertCurrent()
  if (value.surfaceBinding !== undefined) {
    mux.fencePtyPreparationSurface(value.surfaceBinding)
  }
  await mux.fencePtyControlsAndDrain(identity.terminalId, value.signal)
  assertCurrent()
}
