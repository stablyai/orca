import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from '../../../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../../../shared/pty-ownership-transfer-identity'
import {
  fencePtyRouteRefusals,
  getPtyRouteRefusal,
  assertPtyRouteAdmissionAllowed
} from './pty-route-refusal'

/** Restore only from validated durable source-release evidence; never marks a process exited. */
export function fenceOutgoingSourcePtyRoutes(
  targetId: string,
  values: readonly PtyOwnershipTransferWireIdentity[],
  recordSha256: string
): void {
  if (!targetId || !/^[a-f0-9]{64}$/.test(recordSha256)) {
    throw new Error('orcad_outgoing_source_route_target_required')
  }
  const cohort = values.map((value) => {
    const identity = parsePtyOwnershipTransferWireIdentity(value)
    return { ptyId: toAppSshPtyId(targetId, identity.terminalId), identity }
  })
  const candidates = new Map<string, PtyOwnershipTransferWireIdentity>()
  for (const { ptyId, identity } of cohort) {
    const retained = getPtyRouteRefusal(ptyId)
    if (retained && retained.kind !== 'ownership-transfer') {
      throw new Error('orcad_outgoing_source_route_record_conflict')
    }
    if (retained && retained.recordSha256 !== recordSha256) {
      throw new Error('orcad_outgoing_source_route_record_conflict')
    }
    for (const previous of [retained?.identity, candidates.get(ptyId)]) {
      if (previous && !samePtyOwnershipTransferIdentity(previous, identity)) {
        throw new Error('orcad_outgoing_source_route_identity_conflict')
      }
    }
    candidates.set(ptyId, identity)
  }
  fencePtyRouteRefusals(
    Array.from(candidates, ([ptyId, identity]) => ({
      ptyId,
      proof: { kind: 'ownership-transfer' as const, identity, recordSha256 }
    }))
  )
}

export function assertOutgoingSourcePtyRouteAllowed(ptyId: string): void {
  assertPtyRouteAdmissionAllowed(ptyId)
}

export function hasExactOutgoingSourcePtyRouteRefusal(
  ptyId: string,
  identity: PtyOwnershipTransferWireIdentity,
  recordSha256: string
): boolean {
  const entry = getPtyRouteRefusal(ptyId)
  return (
    !!entry &&
    entry.kind === 'ownership-transfer' &&
    entry.recordSha256 === recordSha256 &&
    samePtyOwnershipTransferIdentity(entry.identity, identity)
  )
}
