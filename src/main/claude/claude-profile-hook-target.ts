import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { getConfigPath, type ClaudeCompatibleHookSettings } from './hook-settings'

function sameFile(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) {
    return true
  }
  try {
    // Why: file identity, not spelling, so links and case-only aliases both compare equal.
    const leftStats = statSync(left, { bigint: true })
    const rightStats = statSync(right, { bigint: true })
    return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino
  } catch (error) {
    // Why: only a definitive absence proves they differ; any other failure refuses.
    return !isDefinitiveAbsence(error)
  }
}

/** A profile destination that is, or links into, the default home would edit System Default's hooks. */
export function refuseProfileAtDefaultHome(
  service: { agent: AgentHookInstallStatus['agent']; settings: ClaudeCompatibleHookSettings },
  configDir: string | undefined
): AgentHookInstallStatus | null {
  if (configDir === undefined) {
    return null
  }
  const configPath = getConfigPath(service.settings, configDir)
  const defaultSettings = getConfigPath(service.settings)
  if (!sameFile(configDir, dirname(defaultSettings)) && !sameFile(configPath, defaultSettings)) {
    return null
  }
  return {
    agent: service.agent,
    state: 'error',
    configPath,
    managedHooksPresent: false,
    detail: 'Profile settings resolve to the default home'
  }
}
