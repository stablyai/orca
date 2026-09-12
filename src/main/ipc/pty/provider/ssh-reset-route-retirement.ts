import { randomUUID } from 'node:crypto'
import type { IPtyProvider } from '../../../providers/types'
import type { SshRelayResetIntent } from '../../../ssh/ssh-relay-reset-intent'
import {
  parseSshRelayResetRetirementSelection,
  parseSshRelayResetPreparationReceipt,
  sshRelayResetRecordDigest,
  type SshRelayResetRetirementSelection,
  type SshRelayResetPreparationReceipt
} from '../../../ssh/ssh-relay-reset-retirement-record'
import { ptyOwnership, ptyIncarnationById } from './ownership-state'
import { sshProviders, sshProvidersByGeneration } from './registry'
import { clearProviderPtyState } from './state-cleanup'
import {
  fencePtyRouteRefusals,
  getPtyRouteRefusal,
  type PtyRouteRefusal
} from './pty-route-refusal'

export const SSH_RESET_CLIENT_INCARNATION: string = randomUUID()

type SshResetRouteRetirementOptions = {
  intent: SshRelayResetIntent
  selection: SshRelayResetRetirementSelection
  receipt: SshRelayResetPreparationReceipt
  expectedProvider?: IPtyProvider
  assertAuthority: () => void
}

function selectSshResetRoutes(options: SshResetRouteRetirementOptions) {
  const selection = parseSshRelayResetRetirementSelection(options.selection, options.intent)
  const receipt = parseSshRelayResetPreparationReceipt(options.receipt, options.intent, selection)
  const targetId = options.intent.targetId
  const { expectedProvider, assertAuthority } = options
  const recordSha256 = sshRelayResetRecordDigest(receipt)
  const sameClient = selection.clientIncarnation === SSH_RESET_CLIENT_INCARNATION
  const entries = selection.routes.map((route) => ({
    ptyId: route.appPtyId,
    route,
    proof: Object.freeze({
      kind: 'relay-reset' as const,
      recordSha256,
      clientIncarnation: selection.clientIncarnation,
      incarnationId: route.incarnationId,
      providerGeneration: route.providerGeneration
    })
  }))
  const sameProof = (value: PtyRouteRefusal | undefined, expected: PtyRouteRefusal) =>
    !!value && sshRelayResetRecordDigest(value) === sshRelayResetRecordDigest(expected)
  assertAuthority()
  const selected = entries.map((entry) => {
    const { ptyId, route, proof } = entry
    const previous = getPtyRouteRefusal(ptyId)
    if (previous && !sameProof(previous, proof)) {
      throw new Error('pty_route_refusal_conflict')
    }
    const present = ptyOwnership.has(ptyId) || ptyIncarnationById.has(ptyId)
    if (
      present &&
      (!sameClient ||
        !expectedProvider ||
        sshProviders.get(targetId) !== expectedProvider ||
        sshProvidersByGeneration.get(route.providerGeneration) !== expectedProvider ||
        (expectedProvider as { providerGeneration?: number }).providerGeneration !==
          route.providerGeneration ||
        ptyOwnership.get(ptyId) !== targetId ||
        ptyIncarnationById.get(ptyId) !== route.incarnationId)
    ) {
      throw new Error('ssh_reset_route_selection_changed')
    }
    return {
      ...entry,
      cleanup: sameClient && (present || sameProof(getPtyRouteRefusal(ptyId), proof))
    }
  })
  return { selected, assertAuthority, sameProof }
}

/** Validate route identity before a separate lease durability barrier mutates its cohort. */
export function assertSshResetRoutesRetirable(options: SshResetRouteRetirementOptions): void {
  selectSshResetRoutes(options)
}

/** Retires local routes only; receipt does not establish remote process exit. */
export function retireSshResetRoutes(options: SshResetRouteRetirementOptions) {
  const { selected, assertAuthority, sameProof } = selectSshResetRoutes(options)
  fencePtyRouteRefusals(selected)
  for (const { ptyId } of selected) {
    ptyOwnership.delete(ptyId)
    ptyIncarnationById.delete(ptyId)
  }
  const assertRetired = () => {
    assertAuthority()
    for (const { ptyId, proof } of selected) {
      if (
        ptyOwnership.has(ptyId) ||
        ptyIncarnationById.has(ptyId) ||
        !sameProof(getPtyRouteRefusal(ptyId), proof)
      ) {
        throw new Error('ssh_reset_route_retirement_unconfirmed')
      }
    }
  }
  for (const { ptyId, cleanup } of selected) {
    assertRetired()
    if (cleanup) {
      clearProviderPtyState(ptyId)
    }
  }
  assertRetired()
  return { assertRetired }
}
