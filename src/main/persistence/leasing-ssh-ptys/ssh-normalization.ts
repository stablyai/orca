import type {
  SshPtyConsumerRecovery,
  SshRemotePtyLease,
  SshTarget
} from '../../../shared/ssh-types'
import { LEGACY_DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS } from '../../../shared/ssh-types'
import { normalizeSshPendingPtyKill } from '../../../shared/ssh-pending-pty-kill'

export type LegacySshTarget = SshTarget & {
  remoteWorkspaceSyncEnabled?: unknown
  remoteWorkspaceSyncGracePeriodSeconds?: unknown
  experimentalPtySourceCreditV1?: unknown
}

// Why: old targets predate configHost; default to label-based lookup so imported SSH aliases still resolve via ssh -G.
export function normalizeSshTarget(t: SshTarget): SshTarget {
  const target = { ...(t as LegacySshTarget) }
  const legacySyncEnabled = target.remoteWorkspaceSyncEnabled
  const currentGracePeriodSeconds = target.relayGracePeriodSeconds
  const legacyGracePeriodSeconds = target.remoteWorkspaceSyncGracePeriodSeconds
  const systemSshConnectionReuse = target.systemSshConnectionReuse
  // Why: remote sync now follows the SSH relay lifecycle, so retired per-target sync/grace fields are dropped at disk load.
  delete target.remoteWorkspaceSyncEnabled
  delete target.remoteWorkspaceSyncGracePeriodSeconds
  delete target.relayGracePeriodSeconds
  delete target.systemSshConnectionReuse
  delete target.experimentalPtySourceCreditV1
  // Why: prefer the synced grace over stale relayGracePeriodSeconds so a user's "unlimited" (0) survives migration.
  const relayGracePeriodSeconds =
    legacySyncEnabled === true && typeof legacyGracePeriodSeconds === 'number'
      ? legacyGracePeriodSeconds
      : currentGracePeriodSeconds
  const normalized: SshTarget = {
    ...target,
    configHost: target.configHost ?? target.label ?? target.host
  }
  // Why: old SSH form persisted 10800 even without a user choice; treat that legacy default as the new implicit default.
  if (
    relayGracePeriodSeconds !== undefined &&
    relayGracePeriodSeconds !== LEGACY_DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
  ) {
    normalized.relayGracePeriodSeconds = relayGracePeriodSeconds
  }
  if (systemSshConnectionReuse === false) {
    normalized.systemSshConnectionReuse = false
  }
  return normalized
}

// Why: strict whitelist — a record missing or mistyping a required field is dropped rather than partially trusted.
export function normalizeSshRemotePtyLease(value: unknown): SshRemotePtyLease | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Partial<SshRemotePtyLease>
  if (typeof raw.targetId !== 'string' || typeof raw.ptyId !== 'string') {
    return null
  }
  const state = raw.state ?? 'detached'
  if (!['attached', 'detached', 'terminated', 'expired'].includes(state)) {
    return null
  }
  const now = Date.now()
  const pendingKill = normalizeSshPendingPtyKill(raw.pendingKill)
  return {
    targetId: raw.targetId,
    ptyId: raw.ptyId,
    ...(pendingKill ? { pendingKill } : {}),
    ...(typeof raw.worktreeId === 'string' ? { worktreeId: raw.worktreeId } : {}),
    ...(typeof raw.tabId === 'string' ? { tabId: raw.tabId } : {}),
    ...(typeof raw.leafId === 'string' && raw.leafId.length <= 256 ? { leafId: raw.leafId } : {}),
    state,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
    ...(typeof raw.lastAttachedAt === 'number' ? { lastAttachedAt: raw.lastAttachedAt } : {}),
    ...(typeof raw.lastDetachedAt === 'number' ? { lastDetachedAt: raw.lastDetachedAt } : {})
  }
}

export const SSH_PTY_OWNER_LEASE_MAX_LENGTH = 512
export const ENCRYPTED_SSH_PTY_OWNER_LEASE_MAX_LENGTH = 4096

export function normalizeSshPtyConsumerRecovery(
  value: unknown,
  ownerLeaseMaxLength = SSH_PTY_OWNER_LEASE_MAX_LENGTH
): SshPtyConsumerRecovery | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Partial<SshPtyConsumerRecovery>
  const clientGeneration = raw.clientGeneration
  const ownerGeneration = raw.ownerGeneration
  if (
    typeof raw.targetId !== 'string' ||
    raw.targetId.length === 0 ||
    raw.targetId.length > 512 ||
    typeof raw.clientInstanceId !== 'string' ||
    raw.clientInstanceId.length === 0 ||
    raw.clientInstanceId.length > 512 ||
    typeof raw.serverBuildId !== 'string' ||
    raw.serverBuildId.length === 0 ||
    raw.serverBuildId.length > 512 ||
    typeof clientGeneration !== 'number' ||
    !Number.isSafeInteger(clientGeneration) ||
    clientGeneration <= 0 ||
    typeof ownerGeneration !== 'number' ||
    !Number.isSafeInteger(ownerGeneration) ||
    ownerGeneration <= 0 ||
    typeof raw.ownerLease !== 'string' ||
    raw.ownerLease.length === 0 ||
    raw.ownerLease.length > ownerLeaseMaxLength
  ) {
    return null
  }
  const flow = raw.outputFlowControl
  const outputFlowControl =
    flow?.version === 1 && Number.isSafeInteger(flow.windowSu) && flow.windowSu > 0
      ? { version: 1 as const, windowSu: flow.windowSu }
      : undefined
  return {
    targetId: raw.targetId,
    clientInstanceId: raw.clientInstanceId,
    serverBuildId: raw.serverBuildId,
    clientGeneration,
    ownerGeneration,
    ownerLease: raw.ownerLease,
    ...(outputFlowControl ? { outputFlowControl } : {})
  }
}
