import { createHash } from 'node:crypto'
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { normalizeSshRemotePtyLease } from '../persistence/leasing-ssh-ptys/ssh-normalization'
import {
  parseRelayOwnerResetAcknowledgment,
  type RelayOwnerResetAcknowledgment
} from '../../shared/relay-owner-reset-contract'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from './ssh-relay-reset-intent'

export type SshRelayResetRetirementSelection = Readonly<{
  version: 1
  intentSha256: string
  clientIncarnation: string
  retiredAt: number
  leases: readonly SshRemotePtyLease[]
  routes: readonly Readonly<{
    appPtyId: string
    incarnationId: string
    providerGeneration: number
  }>[]
}>

export type SshRelayResetPreparationReceipt = Readonly<{
  version: 1
  intentSha256: string
  selectionSha256: string
  acknowledgment: RelayOwnerResetAcknowledgment
}>

export type SshRelayResetCompletion = Readonly<{
  version: 1
  intentSha256: string
  selectionSha256: string
  receiptSha256: string
  localRetired: true
}>

export function sshRelayResetRecordDigest(value: unknown): string {
  return createHash('sha256').update(serializeOrcadMigrationValue(value)).digest('hex')
}

export function parseSshRelayResetRetirementSelection(
  value: unknown,
  expected: SshRelayResetIntent
): SshRelayResetRetirementSelection {
  const intent = parseSshRelayResetIntent(expected)
  const raw = value as SshRelayResetRetirementSelection | null
  if (
    !raw ||
    raw.version !== 1 ||
    raw.intentSha256 !== sshRelayResetRecordDigest(intent) ||
    !isPtyIncarnationId(raw.clientIncarnation) ||
    !Number.isSafeInteger(raw.retiredAt) ||
    raw.retiredAt < 0 ||
    !Array.isArray(raw.leases) ||
    !Array.isArray(raw.routes) ||
    raw.leases.length > 10_000 ||
    raw.routes.length > 10_000
  ) {
    throw new Error('ssh_relay_reset_selection_invalid')
  }
  const leaseIds = new Set<string>()
  const leases = raw.leases.map((entry) => {
    const lease = normalizeSshRemotePtyLease(entry)
    // Normalization may repair old profiles; retirement evidence must never be repaired.
    if (
      !lease ||
      serializeOrcadMigrationValue(lease) !== serializeOrcadMigrationValue(entry) ||
      lease.targetId !== intent.targetId ||
      !lease.ptyId ||
      lease.ptyId.length > 1024 ||
      leaseIds.has(lease.ptyId) ||
      !Number.isFinite(lease.createdAt) ||
      !Number.isFinite(lease.updatedAt)
    ) {
      throw new Error('ssh_relay_reset_selection_lease_invalid')
    }
    leaseIds.add(lease.ptyId)
    if (lease.pendingKill) {
      Object.freeze(lease.pendingKill)
    }
    return Object.freeze(lease)
  })
  const routeIds = new Set<string>()
  const routes = raw.routes.map((route) => {
    if (
      !route ||
      typeof route.appPtyId !== 'string' ||
      !route.appPtyId ||
      route.appPtyId.length > 2048 ||
      parseAppSshPtyId(route.appPtyId)?.connectionId !== intent.targetId ||
      routeIds.has(route.appPtyId) ||
      !isPtyIncarnationId(route.incarnationId) ||
      !Number.isSafeInteger(route.providerGeneration) ||
      route.providerGeneration < 1
    ) {
      throw new Error('ssh_relay_reset_selection_route_invalid')
    }
    routeIds.add(route.appPtyId)
    return Object.freeze({
      appPtyId: route.appPtyId,
      incarnationId: route.incarnationId,
      providerGeneration: route.providerGeneration
    })
  })
  return Object.freeze({
    version: 1,
    intentSha256: raw.intentSha256,
    clientIncarnation: raw.clientIncarnation,
    retiredAt: raw.retiredAt,
    leases: Object.freeze(leases),
    routes: Object.freeze(routes)
  })
}

/** Prepared acknowledgment licenses reconciliation of this selection, not a claim of daemon exit. */
export function parseSshRelayResetPreparationReceipt(
  value: unknown,
  intent: SshRelayResetIntent,
  selection: SshRelayResetRetirementSelection
): SshRelayResetPreparationReceipt {
  const selected = parseSshRelayResetRetirementSelection(selection, intent)
  const raw = value as SshRelayResetPreparationReceipt | null
  if (
    !raw ||
    raw.version !== 1 ||
    raw.intentSha256 !== selected.intentSha256 ||
    raw.selectionSha256 !== sshRelayResetRecordDigest(selected)
  ) {
    throw new Error('ssh_relay_reset_receipt_binding_invalid')
  }
  return Object.freeze({
    version: 1,
    intentSha256: raw.intentSha256,
    selectionSha256: raw.selectionSha256,
    acknowledgment: Object.freeze(
      parseRelayOwnerResetAcknowledgment(raw.acknowledgment, intent.request)
    )
  })
}

/** Records local reconciliation only; it never upgrades remote liveness to exited. */
export function parseSshRelayResetCompletion(
  value: unknown,
  intent: SshRelayResetIntent,
  selection: SshRelayResetRetirementSelection,
  receipt: SshRelayResetPreparationReceipt
): SshRelayResetCompletion {
  const prepared = parseSshRelayResetPreparationReceipt(receipt, intent, selection)
  const raw = value as SshRelayResetCompletion | null
  if (
    !raw ||
    raw.version !== 1 ||
    raw.localRetired !== true ||
    raw.intentSha256 !== prepared.intentSha256 ||
    raw.selectionSha256 !== prepared.selectionSha256 ||
    raw.receiptSha256 !== sshRelayResetRecordDigest(prepared)
  ) {
    throw new Error('ssh_relay_reset_completion_binding_invalid')
  }
  return Object.freeze({
    version: 1,
    intentSha256: raw.intentSha256,
    selectionSha256: raw.selectionSha256,
    receiptSha256: raw.receiptSha256,
    localRetired: true
  })
}
