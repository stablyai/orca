import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'
import { parseAppSshPtyId, toRelaySshPtyId } from '../../shared/ssh-pty-id'
import type { IPtyProvider } from './types'

export type SshPtyOutgoingControlRelease = { identity: unknown; providerGeneration: number }

/** Provider-local control fence; not output-drain, process-exit or durable migration evidence. */
export class SshPtyOutgoingControlFence {
  private readonly released = new Map<string, PtyOwnershipTransferWireIdentity>()

  constructor(
    private readonly targetId: string,
    private readonly providerGeneration: number
  ) {}

  release(
    value: SshPtyOutgoingControlRelease,
    readSource: NonNullable<IPtyProvider['getOwnershipTransferSourceIdentity']>
  ): void {
    if (!isPtyOwnershipTransferMutationEnabled()) {
      throw new Error('pty_ownership_transfer_mutation_disabled')
    }
    const identity = parsePtyOwnershipTransferWireIdentity(value.identity)
    if (
      value.providerGeneration !== this.providerGeneration ||
      !Number.isSafeInteger(this.providerGeneration) ||
      this.providerGeneration <= 0 ||
      parseAppSshPtyId(identity.terminalId)
    ) {
      throw new Error('orcad_outgoing_control_fence_binding_invalid')
    }
    const previous = this.released.get(identity.terminalId)
    if (previous) {
      if (!samePtyOwnershipTransferIdentity(previous, identity)) {
        throw new Error('orcad_outgoing_control_fence_conflict')
      }
      return
    }
    const source = readSource(identity.terminalId)
    if (
      !source ||
      source.terminalId !== identity.terminalId ||
      source.incarnationId !== identity.incarnationId ||
      source.ownerLease !== identity.ownerLease ||
      source.sourceOwnerGeneration !== identity.sourceOwnerGeneration
    ) {
      throw new Error('orcad_outgoing_control_fence_source_changed')
    }
    this.released.set(identity.terminalId, Object.freeze({ ...identity }))
  }

  isReleased(id: string, expectedIdentity?: unknown): boolean {
    const released = this.released.get(toRelaySshPtyId(this.targetId, id))
    if (!released) {
      return false
    }
    return expectedIdentity === undefined
      ? true
      : samePtyOwnershipTransferIdentity(
          released,
          parsePtyOwnershipTransferWireIdentity(expectedIdentity)
        )
  }

  assertControlAllowed(id: string): void {
    if (this.isReleased(id)) {
      throw new Error('orcad_outgoing_source_control_released')
    }
  }
}
