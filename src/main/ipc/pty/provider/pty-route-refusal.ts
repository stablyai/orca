import { serializeOrcadMigrationValue } from '../../../../shared/orcad-migration-manifest'
import type { PtyOwnershipTransferWireIdentity } from '../../../../shared/pty-ownership-transfer-wire'

export type PtyRouteRefusal = Readonly<
  | { kind: 'ownership-transfer'; identity: PtyOwnershipTransferWireIdentity; recordSha256: string }
  | {
      kind: 'relay-reset'
      recordSha256: string
      clientIncarnation: string
      incarnationId: string
      providerGeneration: number
    }
>

const refused = new Map<string, PtyRouteRefusal>()

/** Validate the complete set before publishing any admission refusal. */
export function fencePtyRouteRefusals(
  entries: readonly { ptyId: string; proof: PtyRouteRefusal }[]
): void {
  const candidates = new Map<string, PtyRouteRefusal>()
  for (const { ptyId, proof } of entries) {
    for (const previous of [refused.get(ptyId), candidates.get(ptyId)]) {
      if (
        previous &&
        serializeOrcadMigrationValue(previous) !== serializeOrcadMigrationValue(proof)
      ) {
        throw new Error('pty_route_refusal_conflict')
      }
    }
    candidates.set(
      ptyId,
      Object.freeze(
        proof.kind === 'ownership-transfer'
          ? { ...proof, identity: Object.freeze({ ...proof.identity }) }
          : { ...proof }
      )
    )
  }
  for (const [ptyId, proof] of candidates) {
    refused.set(ptyId, proof)
  }
}

export function getPtyRouteRefusal(ptyId: string): PtyRouteRefusal | undefined {
  return refused.get(ptyId)
}

export function assertPtyRouteAdmissionAllowed(ptyId: string): void {
  const proof = refused.get(ptyId)
  if (proof) {
    throw new Error(
      proof.kind === 'relay-reset'
        ? 'ssh_relay_reset_route_retired'
        : 'orcad_outgoing_source_control_released'
    )
  }
}
