import { z } from 'zod'
import type {
  SshPtyConsumerRecovery,
  SshRemotePtyLease,
  SshRemoteRuntimeResolution,
  SshTarget
} from '../../../shared/ssh-types'
import {
  LEGACY_DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  SSH_REMOTE_RUNTIME_RUNGS,
  SSH_REMOTE_RUNTIMES
} from '../../../shared/ssh-types'
import { normalizeSshPendingPtyKill } from '../../../shared/ssh-pending-pty-kill'
import { getLegacyManagedOrcadOwnerEnvironmentId } from '../../../shared/managed-orcad-ssh-owner'

export type LegacySshTarget = SshTarget & {
  remoteWorkspaceSyncEnabled?: unknown
  remoteWorkspaceSyncGracePeriodSeconds?: unknown
  experimentalPtySourceCreditV1?: unknown
  allowRemoteCliControlReset?: unknown
}

// Legacy targets lack configHost; label fallback preserves imported ssh -G aliases.
export function normalizeSshTarget(t: SshTarget): SshTarget {
  const target = { ...(t as LegacySshTarget) }
  const legacySyncEnabled = target.remoteWorkspaceSyncEnabled
  const currentGracePeriodSeconds = target.relayGracePeriodSeconds
  const legacyGracePeriodSeconds = target.remoteWorkspaceSyncGracePeriodSeconds
  const systemSshConnectionReuse = target.systemSshConnectionReuse
  const systemSshProxyConnectionReuse = target.systemSshProxyConnectionReuse
  const remoteRuntime = target.remoteRuntime
  const remoteRuntimeResolution = normalizeSshRemoteRuntimeResolution(
    target.remoteRuntimeResolution
  )
  // Sync/grace now follow relay lifecycle; discard retired per-target fields.
  delete target.remoteWorkspaceSyncEnabled
  delete target.remoteWorkspaceSyncGracePeriodSeconds
  delete target.relayGracePeriodSeconds
  delete target.systemSshConnectionReuse
  delete target.systemSshProxyConnectionReuse
  delete target.remoteRuntime
  delete target.remoteRuntimeResolution
  delete target.experimentalPtySourceCreditV1
  delete target.allowRemoteCliControlReset
  // Preserve explicit synced unlimited grace (0) over a stale relay setting.
  const relayGracePeriodSeconds =
    legacySyncEnabled === true && typeof legacyGracePeriodSeconds === 'number'
      ? legacyGracePeriodSeconds
      : currentGracePeriodSeconds
  const normalized: SshTarget = {
    ...target,
    configHost: target.configHost ?? target.label ?? target.host
  }
  // Old forms persisted the former default even without user choice; migrate it as implicit.
  if (
    relayGracePeriodSeconds !== undefined &&
    relayGracePeriodSeconds !== LEGACY_DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
  ) {
    normalized.relayGracePeriodSeconds = relayGracePeriodSeconds
  }
  if (systemSshConnectionReuse === false) {
    normalized.systemSshConnectionReuse = false
  }
  if (systemSshProxyConnectionReuse === true) {
    normalized.systemSshProxyConnectionReuse = true
  }
  // Keep explicit runtime choices; unknown newer values must not silently select another runtime.
  const knownRuntime = SSH_REMOTE_RUNTIMES.find((runtime) => runtime === remoteRuntime)
  if (knownRuntime) {
    normalized.remoteRuntime = knownRuntime
  }
  if (remoteRuntimeResolution) {
    normalized.remoteRuntimeResolution = remoteRuntimeResolution
  }
  return normalizeManagedServerLeaveBehind(
    normalizeManagedServerMoveOffered(
      normalizeAppVersionNote(
        normalizeAppVersionNote(
          migrateLegacyManagedOrcadOwner(normalized),
          'managedServerUnavailable'
        ),
        'managedServerUpdateFailure'
      )
    )
  )
}

/** Move legacy owner fences to orcadFence so downgraded builds still show and reach the host. */
function migrateLegacyManagedOrcadOwner(target: SshTarget): SshTarget {
  const environmentId = getLegacyManagedOrcadOwnerEnvironmentId(target.owner)
  if (!environmentId) {
    return normalizeOrcadFence(target)
  }
  const { owner: _legacyOwner, ...rest } = target
  const fenced = normalizeOrcadFence(rest)
  return fenced.orcadFence ? fenced : { ...fenced, orcadFence: { environmentId } }
}

// Preserve unknown note fields from independently updated peers.
function noteFields(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null
}

function normalizeAppVersionNote(
  target: SshTarget,
  key: 'managedServerUnavailable' | 'managedServerUpdateFailure'
): SshTarget {
  if (target[key] === undefined) {
    return target
  }
  const note = noteFields(target[key])
  if (typeof note?.reason === 'string' && typeof note.appVersion === 'string') {
    return { ...target, [key]: { ...note, reason: note.reason, appVersion: note.appVersion } }
  }
  const { [key]: _malformed, ...rest } = target
  return rest
}

function normalizeManagedServerMoveOffered(target: SshTarget): SshTarget {
  if (target.managedServerMoveOffered === undefined) {
    return target
  }
  const note = noteFields(target.managedServerMoveOffered)
  if (typeof note?.appVersion === 'string') {
    return { ...target, managedServerMoveOffered: { ...note, appVersion: note.appVersion } }
  }
  const { managedServerMoveOffered: _malformed, ...rest } = target
  return rest
}

function normalizeManagedServerLeaveBehind(target: SshTarget): SshTarget {
  if (target.managedServerLeaveBehind === undefined) {
    return target
  }
  const note = noteFields(target.managedServerLeaveBehind)
  if (typeof note?.confirmedAt === 'string') {
    return { ...target, managedServerLeaveBehind: { ...note, confirmedAt: note.confirmedAt } }
  }
  const { managedServerLeaveBehind: _malformed, ...rest } = target
  return rest
}

function normalizeOrcadFence(target: SshTarget): SshTarget {
  if (target.orcadFence === undefined) {
    return target
  }
  const fence = noteFields(target.orcadFence)
  const environmentId = fence?.environmentId
  if (fence && typeof environmentId === 'string' && environmentId.length > 0) {
    const { sourceChangedAt, ...unknownAndId } = fence
    return {
      ...target,
      orcadFence: {
        ...unknownAndId,
        environmentId,
        ...(typeof sourceChangedAt === 'string' ? { sourceChangedAt } : {})
      }
    }
  }
  const { orcadFence: _malformed, ...rest } = target
  return rest
}

// Malformed cache entries only cost a new runtime-resolution attempt.
const SshRemoteRuntimeResolutionSchema = z
  .object({
    rung: z.enum(SSH_REMOTE_RUNTIME_RUNGS),
    pinnedRefusal: z.string().max(64).optional(),
    refusedAt: z.number().int().nonnegative().optional(),
    glibc: z
      .string()
      .regex(/^\d+\.\d+$/)
      .nullable(),
    runtimeSha256: z.string().regex(/^[0-9a-f]{64}$/),
    orcaMajor: z.number().int().nonnegative()
  })
  .strict()

function normalizeSshRemoteRuntimeResolution(value: unknown): SshRemoteRuntimeResolution | null {
  const parsed = SshRemoteRuntimeResolutionSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

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
  const pendingKill = normalizeSshPendingPtyKill(raw.pendingKill, raw.ptyId)
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
    ...(typeof raw.lastDetachedAt === 'number' ? { lastDetachedAt: raw.lastDetachedAt } : {}),
    // Keep supersession evidence or a reload could make retired predecessors reattachable.
    ...(typeof raw.supersededBy === 'string' && raw.supersededBy.length > 0
      ? { supersededBy: raw.supersededBy }
      : {}),
    ...(raw.relayIdRecycled === true ? { relayIdRecycled: true as const } : {})
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
