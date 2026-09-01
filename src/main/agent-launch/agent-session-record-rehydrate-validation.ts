// Rehydrate-only structural checks for persisted session records. Persisted JSON
// is untrusted shape; the resume replay paths read snapshot argv/agentEnv/target
// (and legacy agentArgs/agentEnv) without re-validating, so a corrupt payload
// must be dropped at rehydrate for resume to degrade to the in-band
// invalid_launch_snapshot instead of throwing.

import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import {
  getAgentSessionOwnershipKey,
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  providerSessionKeyForResumableBase,
  type SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import { isBuiltInTuiAgent, isTuiAgent } from '../../shared/tui-agent-config'
// Type-only import: erased at runtime, so no import cycle with the store.
import type { HostSessionLaunchRecord } from './agent-session-record-store'

const SNAPSHOT_MODES: ReadonlySet<unknown> = new Set(['built-in', 'custom', 'safe-fallback'])
const CAPTURED_ENV_POLICIES: ReadonlySet<unknown> = new Set(['full', 'withheld', 'none'])

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  )
}

export function isWellFormedLaunchSnapshot(value: unknown): value is AgentLaunchSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const snapshot = value as Record<string, unknown>
  const target = snapshot.target as Record<string, unknown> | null | undefined
  return Boolean(
    snapshot.version === 1 &&
    isTuiAgent(snapshot.requestedAgent) &&
    isBuiltInTuiAgent(snapshot.baseAgent) &&
    typeof snapshot.displayLabel === 'string' &&
    SNAPSHOT_MODES.has(snapshot.mode) &&
    Array.isArray(snapshot.argv) &&
    snapshot.argv.length > 0 &&
    snapshot.argv.every((element) => typeof element === 'string') &&
    isStringRecord(snapshot.agentEnv) &&
    CAPTURED_ENV_POLICIES.has(snapshot.capturedEnvPolicy) &&
    typeof target === 'object' &&
    target !== null &&
    typeof target.platform === 'string' &&
    (target.execution === 'native' || target.execution === 'wsl') &&
    typeof target.shell === 'string' &&
    typeof target.isRemote === 'boolean' &&
    typeof target.executionHostId === 'string'
  )
}

export function isWellFormedLegacyLaunchConfig(value: unknown): value is SleepingAgentLaunchConfig {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const config = value as Record<string, unknown>
  return (
    (config.agentCommand === undefined || typeof config.agentCommand === 'string') &&
    typeof config.agentArgs === 'string' &&
    isStringRecord(config.agentEnv)
  )
}

/** Validate + normalize one persisted record for rehydrate: drop it (null) on a
 *  missing/incompatible provider session or a non-resumable/invalid identity, else
 *  return the normalized record and its ownership key. A corrupt replay payload is
 *  stripped (record kept) so resume returns the in-band invalid_launch_snapshot
 *  rather than throwing. */
export function rehydrateSessionRecord(
  record: HostSessionLaunchRecord
): { ownershipKey: string; record: HostSessionLaunchRecord } | null {
  const providerSession = normalizeAgentProviderSession(record?.providerSession)
  if (
    typeof record?.worktreeId !== 'string' ||
    !record.worktreeId ||
    !isTuiAgent(record.requestedAgent) ||
    !isResumableTuiAgent(record.baseAgent) ||
    !providerSession ||
    // Enforce the same providerSession.key ↔ base compatibility bind() requires: a
    // mismatched persisted pair would replay the wrong provider's resume flags.
    providerSession.key !== providerSessionKeyForResumableBase(record.baseAgent)
  ) {
    return null
  }
  const snapshotOk =
    record.launchSnapshot === undefined || isWellFormedLaunchSnapshot(record.launchSnapshot)
  const legacyOk =
    record.legacyLaunchConfig === undefined ||
    isWellFormedLegacyLaunchConfig(record.legacyLaunchConfig)
  // Persisted JSON is untrusted shape: store the NORMALIZED provider session and
  // coerce the unvalidated scalar fields so downstream reads never see a non-string
  // token or a non-numeric timestamp.
  const launchToken = typeof record.launchToken === 'string' ? record.launchToken : undefined
  const rehydrated: HostSessionLaunchRecord = {
    ...record,
    providerSession,
    launchSnapshot: snapshotOk ? record.launchSnapshot : undefined,
    legacyLaunchConfig: legacyOk ? record.legacyLaunchConfig : undefined,
    launchToken,
    registeredAt: Number.isFinite(record.registeredAt) ? record.registeredAt : 0,
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0
  }
  const ownershipKey = getAgentSessionOwnershipKey({
    worktreeId: rehydrated.worktreeId,
    baseAgent: rehydrated.baseAgent,
    providerSessionId: providerSession.id
  })
  return { ownershipKey, record: rehydrated }
}
