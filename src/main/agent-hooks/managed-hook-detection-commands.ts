import type { AgentHookTarget } from '../../shared/agent-hook-types'
import {
  extractExecutableToken,
  isSafeOverrideExecutableToken
} from '../../shared/managed-agent-command-token'
import { MANAGED_AGENT_HOOK_TARGETS } from '../../shared/managed-agent-hook-targets'
import { normalizeDisabledTuiAgents } from '../../shared/tui-agent-selection'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { serializeIdentityExclusion } from '../../shared/tui-agent-identity-exclusion'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TuiAgentDetectionCommand } from '../../shared/tui-agent-detection-commands'
import { parseClaudeCliVersion } from '../claude/claude-session-end-hook-capability'

export type ManagedHookDetectionSettings = Partial<
  Pick<GlobalSettings, 'agentCmdOverrides' | 'disabledTuiAgents' | 'agentStatusHooksEnabled'>
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
      // Why: SSH/WSL install allowlists come from this list, so the same-named-tool probe must ride it.
      const exclusion = TUI_AGENT_CONFIG[target.tuiAgent]?.detectIdentityExclusion
      const identity = exclusion ? { identityExclusion: serializeIdentityExclusion(exclusion) } : {}
      return [...commands].map((cmd) => ({
        id: target.tuiAgent,
        cmd,
        ...(target.agent === 'claude' ? { reportVersion: true as const } : {}),
        ...identity
      }))
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

export function readManagedHookDetectionResult(value: unknown): {
  agents: AgentHookTarget[]
  claudeVersion: string | null
} {
  if (value === null || typeof value !== 'object') {
    return { agents: [], claudeVersion: null }
  }
  const agents = detectedManagedHookAgents('agents' in value ? value.agents : null)
  const versions = 'versions' in value ? value.versions : null
  const rawClaudeVersion =
    versions !== null && typeof versions === 'object' && 'claude' in versions
      ? versions.claude
      : null
  return {
    agents,
    claudeVersion: parseClaudeCliVersion(
      typeof rawClaudeVersion === 'string' ? rawClaudeVersion : null
    )
  }
}
