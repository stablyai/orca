import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import {
  claudeConfigDirEnvPatch,
  withoutInheritedClaudeConfigDir
} from '../claude/claude-config-dir-pin'
import { resolveClaudeStructuredLaunchHome } from '../claude/claude-structured-launch-home'
import type { CommitMessageGenerationTarget } from '../text-generation/source-control-text-generation-types'

/** Default naming follows the native account binding; explicit recipes retain CLI routing. */
export async function chatNamingAgentTarget(
  record: AgentSessionRecord,
  cwd: string,
  resolveEnvironment: (agent: string) => Promise<Record<string, string>>,
  settings: Parameters<typeof resolveTuiAgentLaunchEnv>[1]
): Promise<CommitMessageGenerationTarget> {
  let env = await resolveEnvironment(record.provider)
  const spec = acpLaunchSpecFor(record.provider)
  if (spec) {
    env = spec.account.environment(record.accountHome, env)
    const deleted = spec.scrubEnvironment?.(env, process.env) ?? []
    const targetEnv: NodeJS.ProcessEnv = { ...env }
    for (const key of deleted) {
      targetEnv[key] = undefined
    }
    return { kind: 'local', cwd, env: targetEnv }
  }
  const home = requireLegacyAgentSessionAccountHome(record.accountHome)
  if (record.provider === 'claude') {
    env = {
      ...withoutInheritedClaudeConfigDir(env),
      ...resolveTuiAgentLaunchEnv('claude', settings)
    }
    const path = await resolveClaudeStructuredLaunchHome(getClaudeProfileRouter(), env, home.path)
    const patch = claudeConfigDirEnvPatch(path, { env })
    return { kind: 'local', cwd, env: { CLAUDE_CONFIG_DIR: undefined, ...env, ...patch } }
  }
  return { kind: 'local', cwd, env: { ...env, [home.variable]: home.path } }
}
