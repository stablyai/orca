import type { IPtyProvider } from '../../../providers/types'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from '../../../../shared/pty-ownership-transfer-wire'
import { parseAppSshPtyId, toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { sshProviders, sshProvidersByGeneration } from './registry'
import { ptyOwnership, ptyIncarnationById } from './ownership-state'
import {
  fenceOutgoingSourcePtyRoutes,
  hasExactOutgoingSourcePtyRouteRefusal
} from './outgoing-source-route-refusal'

/** Whole-target absence includes routes outside the retained migration cohort. */
export function assertOutgoingSshPtyRoutesAbsent(targetId: string): void {
  for (const [id, owner] of ptyOwnership) {
    if (owner === targetId || parseAppSshPtyId(id)?.connectionId === targetId) {
      throw new Error('orcad_outgoing_route_retirement_route_present')
    }
  }
  for (const id of ptyIncarnationById.keys()) {
    if (parseAppSshPtyId(id)?.connectionId === targetId) {
      throw new Error('orcad_outgoing_route_retirement_route_present')
    }
  }
}

/** Validated durable preparation permits restoring refusal, never removing a reappeared route. */
export function restoreRetiredOutgoingSshPtyRoutes(options: {
  targetId: string
  identities: readonly PtyOwnershipTransferWireIdentity[]
  recordSha256: string
  assertAuthority: () => void
}) {
  const { targetId, recordSha256, assertAuthority } = options
  const identities = options.identities.map(parsePtyOwnershipTransferWireIdentity)
  const ids = identities.map((identity) => toAppSshPtyId(targetId, identity.terminalId))
  if (!ids.length || new Set(ids).size !== ids.length) {
    throw new Error('orcad_outgoing_route_retirement_invalid')
  }
  const assertAbsent = () => {
    assertAuthority()
    if (ids.some((id) => ptyOwnership.has(id) || ptyIncarnationById.has(id))) {
      throw new Error('orcad_outgoing_route_retirement_route_present')
    }
  }
  assertAbsent()
  fenceOutgoingSourcePtyRoutes(targetId, identities, recordSha256)
  const assertRetired = () => {
    assertAbsent()
    if (
      identities.some(
        (identity, index) =>
          !hasExactOutgoingSourcePtyRouteRefusal(ids[index], identity, recordSha256)
      )
    ) {
      throw new Error('orcad_outgoing_route_retirement_unconfirmed')
    }
  }
  assertRetired()
  return { assertRetired }
}

/** Caller holds fresh committed-profile authority and a durable full-cohort completion preparation. */
export function prepareOutgoingSshPtyRouteRetirement(options: {
  targetId: string
  expectedProvider: IPtyProvider
  providerGeneration: number
  identities: readonly PtyOwnershipTransferWireIdentity[]
  recordSha256: string
  assertAuthority: () => void
}) {
  const { targetId, expectedProvider, providerGeneration, recordSha256, assertAuthority } = options
  const identities = options.identities.map(parsePtyOwnershipTransferWireIdentity)
  const cohort = identities.map((identity) => ({
    identity,
    ptyId: toAppSshPtyId(targetId, identity.terminalId)
  }))
  if (
    !targetId ||
    !/^[a-f0-9]{64}$/.test(recordSha256) ||
    !cohort.length ||
    new Set(cohort.map(({ ptyId }) => ptyId)).size !== cohort.length ||
    !Number.isSafeInteger(providerGeneration) ||
    providerGeneration <= 0
  ) {
    throw new Error('orcad_outgoing_route_retirement_invalid')
  }
  let retired = false
  const assertRegistry = () => {
    if (
      sshProviders.get(targetId) !== expectedProvider ||
      sshProvidersByGeneration.get(providerGeneration) !== expectedProvider ||
      (expectedProvider as { providerGeneration?: number }).providerGeneration !==
        providerGeneration
    ) {
      throw new Error('orcad_outgoing_route_retirement_provider_changed')
    }
    for (const { identity, ptyId } of cohort) {
      if (
        ptyOwnership.get(ptyId) !== targetId ||
        ptyIncarnationById.get(ptyId) !== identity.incarnationId
      ) {
        throw new Error('orcad_outgoing_route_retirement_route_changed')
      }
    }
  }
  const assertCurrent = () => {
    assertAuthority()
    if (retired) {
      throw new Error('orcad_outgoing_route_retirement_already_applied')
    }
    for (const { identity, ptyId } of cohort) {
      if (expectedProvider.isOutgoingSourceControlReleased?.(ptyId, identity) !== true) {
        throw new Error('orcad_outgoing_route_retirement_release_required')
      }
    }
    // Recheck all indexes after external authority/provider callbacks, before synchronous mutation.
    assertRegistry()
  }
  const assertRetired = () => {
    assertAuthority()
    for (const { identity, ptyId } of cohort) {
      if (
        ptyOwnership.has(ptyId) ||
        ptyIncarnationById.has(ptyId) ||
        !hasExactOutgoingSourcePtyRouteRefusal(ptyId, identity, recordSha256)
      ) {
        throw new Error('orcad_outgoing_route_retirement_unconfirmed')
      }
    }
  }
  assertCurrent()
  return {
    assertCurrent,
    assertRetired,
    retire() {
      if (retired) {
        assertRetired()
        return
      }
      assertCurrent()
      fenceOutgoingSourcePtyRoutes(targetId, identities, recordSha256)
      for (const { ptyId } of cohort) {
        ptyOwnership.delete(ptyId)
        ptyIncarnationById.delete(ptyId)
      }
      retired = true
      assertRetired()
    }
  }
}
