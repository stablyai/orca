import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  PORTABLE_SETTINGS_SYNC_VERSION,
  PortableSettingsSyncStoreSchema,
  type PortableSettingsSyncPhase,
  type PortableSettingsSyncRule
} from '../shared/portable-settings-sync'

export type PortableSettingsSyncRuntimeState = {
  phase: PortableSettingsSyncPhase
  lastError: string | null
  retryAttempt: number
}

export function readPortableSettingsSyncRules(configPath: string): PortableSettingsSyncRule[] {
  if (!existsSync(configPath)) {
    return []
  }
  try {
    const parsed = PortableSettingsSyncStoreSchema.safeParse(
      JSON.parse(readFileSync(configPath, 'utf8'))
    )
    return parsed.success ? parsed.data.rules : []
  } catch {
    return []
  }
}

export type PortableSettingsSyncRuleCommitter = (
  rule: PortableSettingsSyncRule | null,
  runtimeState: PortableSettingsSyncRuntimeState | null,
  removedEnvironmentId?: string
) => void

export function createPortableSettingsSyncRuleCommitter(
  configPath: string,
  rules: Map<string, PortableSettingsSyncRule>,
  runtimeStates: Map<string, PortableSettingsSyncRuntimeState>,
  onCommit: () => void
): PortableSettingsSyncRuleCommitter {
  return (rule, runtimeState, removedEnvironmentId) => {
    const environmentId = rule?.environmentId ?? removedEnvironmentId
    if (!environmentId) {
      throw new Error('A settings sync rule id is required.')
    }
    commitPortableSettingsSyncRule(
      configPath,
      rules,
      runtimeStates,
      environmentId,
      rule,
      runtimeState
    )
    onCommit()
  }
}

function commitPortableSettingsSyncRule(
  configPath: string,
  rules: Map<string, PortableSettingsSyncRule>,
  runtimeStates: Map<string, PortableSettingsSyncRuntimeState>,
  environmentId: string,
  rule: PortableSettingsSyncRule | null,
  runtimeState: PortableSettingsSyncRuntimeState | null
): void {
  const nextRules = new Map(rules)
  if (rule) {
    nextRules.set(environmentId, rule)
  } else {
    nextRules.delete(environmentId)
  }
  // Persist first so a rejected IPC mutation cannot diverge from the on-disk rule set.
  writePortableSettingsSyncRules(configPath, Array.from(nextRules.values()))
  if (rule && runtimeState) {
    rules.set(environmentId, rule)
    runtimeStates.set(environmentId, runtimeState)
  } else {
    rules.delete(environmentId)
    runtimeStates.delete(environmentId)
  }
}

export function writePortableSettingsSyncRules(
  configPath: string,
  rules: PortableSettingsSyncRule[]
): void {
  mkdirSync(dirname(configPath), { recursive: true })
  const tempPath = `${configPath}.tmp`
  try {
    writeFileSync(
      tempPath,
      `${JSON.stringify({ version: PORTABLE_SETTINGS_SYNC_VERSION, rules }, null, 2)}\n`,
      'utf8'
    )
    renameSync(tempPath, configPath)
  } catch (error) {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath)
      }
    } catch {
      // The original persistence failure is more actionable than cleanup failure.
    }
    throw error
  }
}
