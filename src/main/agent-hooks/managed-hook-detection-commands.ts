import type { AgentHookTarget } from '../../shared/agent-hook-types'
import {
  extractExecutableToken,
  isSafeOverrideExecutableToken
} from '../../shared/managed-agent-command-token'
import { MANAGED_AGENT_HOOK_TARGETS } from '../../shared/managed-agent-hook-targets'
import { normalizeDisabledTuiAgents } from '../../shared/tui-agent-selection'
import type { GlobalSettings } from '../../shared/types'
import type { TuiAgentDetectionCommand } from '../ipc/tui-agent-detection-commands'

export type ManagedHookDetectionSettings = Partial<
  Pick<GlobalSettings, 'agentCmdOverrides' | 'disabledTuiAgents'>
> | null

export function buildManagedHookDetectionCommands(
  settings: ManagedHookDetectionSettings,
  platform: NodeJS.Platform
): TuiAgentDetectionCommand[] {
  const disabled = new Set(normalizeDisabledTuiAgents(settings?.disabledTuiAgents))
  return MANAGED_AGENT_HOOK_TARGETS.filter((target) => !disabled.has(target.tuiAgent)).flatMap(
    (target) => {
      const commands = new Set(target.executableCandidates)
      const override = extractExecutableToken(settings?.agentCmdOverrides?.[target.tuiAgent], {
        platform
      })
      if (override && isSafeOverrideExecutableToken(override)) {
        commands.add(override)
      }
      return [...commands].map((cmd) => ({ id: target.tuiAgent, cmd }))
    }
  )
}

export function detectedManagedHookAgents(values: unknown): AgentHookTarget[] {
  if (!Array.isArray(values)) {
    return []
  }
  const detected = new Set(values.filter((value): value is string => typeof value === 'string'))
  return MANAGED_AGENT_HOOK_TARGETS.filter((target) => detected.has(target.tuiAgent)).map(
    (target) => target.agent
  )
}
