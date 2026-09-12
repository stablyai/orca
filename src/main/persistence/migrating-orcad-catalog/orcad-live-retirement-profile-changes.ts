import type { PersistedState } from '../../../shared/persisted-state-types'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../../shared/workspace-session-host-field-ownership'

const RETIREMENT_FIELDS = [
  'repos',
  'projectGroups',
  'folderWorkspaces',
  'projects',
  'projectHostSetups',
  'worktreeMeta',
  'worktreeMetaByIdentity',
  'worktreeIdentityAliases',
  'worktreeLineageById',
  'workspaceLineageByChildKey',
  'sparsePresetsByRepo',
  'retiredWorktreeNamesByRepo',
  'workspaceSession',
  'workspaceSessionsByHostId',
  'automations',
  'automationRuns',
  'mobileClientTabSelectionsByDeviceId',
  'ui',
  'sshRemotePtyLeases',
  'sshPtyConsumerRecoveries'
] as const satisfies readonly (keyof PersistedState)[]

type RetirementField = (typeof RETIREMENT_FIELDS)[number]
export type OrcadLiveRetirementProfileChange = {
  field: RetirementField
  before: string | null
  after: string | null
}

function savedValue(state: PersistedState, field: RetirementField): string | null {
  return state[field] === undefined ? null : serializeOrcadMigrationValue(state[field])
}

/** Opaque JSON evidence, not validated Store state; null means absent, not JSON null. */
export function parseOrcadLiveRetirementProfileChanges(
  value: unknown
): OrcadLiveRetirementProfileChange[] {
  if (!Array.isArray(value) || !value.length || value.length > RETIREMENT_FIELDS.length) {
    throw new Error('orcad_live_retirement_profile_changes_invalid')
  }
  const fields = new Set<string>()
  const result = value.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !RETIREMENT_FIELDS.includes(entry.field) ||
      fields.has(entry.field)
    ) {
      throw new Error('orcad_live_retirement_profile_field_invalid')
    }
    fields.add(entry.field)
    for (const json of [entry.before, entry.after]) {
      if (
        json !== null &&
        (typeof json !== 'string' || serializeOrcadMigrationValue(JSON.parse(json)) !== json)
      ) {
        throw new Error('orcad_live_retirement_profile_value_invalid')
      }
    }
    if (entry.before === entry.after) {
      throw new Error('orcad_live_retirement_profile_change_empty')
    }
    return {
      field: entry.field as RetirementField,
      before: entry.before as string | null,
      after: entry.after as string | null
    }
  })
  if (!fields.has('sshRemotePtyLeases') || !fields.has('sshPtyConsumerRecoveries')) {
    throw new Error('orcad_live_retirement_profile_authority_required')
  }
  return result.sort((left, right) =>
    left.field < right.field ? -1 : left.field > right.field ? 1 : 0
  )
}

export function collectOrcadLiveRetirementProfileChanges(
  before: PersistedState,
  after: PersistedState
) {
  const allowed = new Set<string>(RETIREMENT_FIELDS)
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (
      !allowed.has(field) &&
      serializeOrcadMigrationValue(before[field as keyof PersistedState]) !==
        serializeOrcadMigrationValue(after[field as keyof PersistedState])
    ) {
      throw new Error('orcad_live_retirement_profile_scope_changed')
    }
  }
  return parseOrcadLiveRetirementProfileChanges(
    RETIREMENT_FIELDS.flatMap((field) => {
      const original = savedValue(before, field)
      const candidate = savedValue(after, field)
      return original === candidate ? [] : [{ field, before: original, after: candidate }]
    })
  )
}

/** A conflict never licenses overwriting newer state, even when it shares a touched profile slice. */
export function inspectOrcadLiveRetirementProfileChanges(state: PersistedState, value: unknown) {
  const changes = parseOrcadLiveRetirementProfileChanges(value)
  const before = changes.every((change) => savedValue(state, change.field) === change.before)
  const after = changes.every((change) => savedValue(state, change.field) === change.after)
  return before ? ('before' as const) : after ? ('after' as const) : ('conflict' as const)
}

export function listOrcadLiveRetirementProfileDrift(state: PersistedState, value: unknown) {
  return parseOrcadLiveRetirementProfileChanges(value)
    .filter((change) => savedValue(state, change.field) !== change.after)
    .flatMap((change): string[] => {
      if (change.field !== 'workspaceSession' || change.after === null) {
        return [change.field]
      }
      const expected = JSON.parse(change.after) as PersistedState['workspaceSession']
      const current = state.workspaceSession
      const fields = (Object.keys(WORKSPACE_SESSION_FIELD_OWNERSHIP) as (keyof typeof current)[])
        .filter(
          (field) =>
            serializeOrcadMigrationValue(expected?.[field]) !==
            serializeOrcadMigrationValue(current?.[field])
        )
        .map((field) => `workspaceSession.${field}`)
      return fields.length ? fields : [change.field]
    })
}
