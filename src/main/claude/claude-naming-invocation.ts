import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { agentSessionPinnedLaunchDirectory } from '../runtime/agent-session-record-launch-directory'
import type { StructuredAgentLaunchSources } from '../runtime/structured-agent-launch-composition'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'
import { claudeChildEnv, resolveClaudeChildEnvSources } from './claude-structured-child-env'
import { claudeStructuredLaunchArgs } from './claude-structured-launch-args'
import { claudeConfigDirEnvPatch, withoutInheritedClaudeConfigDir } from './claude-config-dir-pin'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'
import type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
import { resolve } from 'node:path'
import type { ClaudeEnvDeps } from './claude-structured-child-env'

export type ClaudeNamingInputs = {
  command: string
  cwd: string
  home: string
  env: Readonly<Record<string, string>>
  extraArgs: Readonly<Record<string, string | null>>
}

/** Capture the selected policy now; only its independent I/O remains on the naming task. */
export function claudeNamingInvocation(
  sources: StructuredAgentLaunchSources,
  resolveArgs: () => Promise<string[]> | string[],
  resolveCommand?: ClaudeEnvDeps['resolveCommand']
): (record: AgentSessionRecord) => Promise<ClaudeNamingInputs> {
  return (record) => {
    const configured = sources.resolveCommandSettings?.()
    const settings = configured ? structuredClone(configured) : undefined
    const overlay = { ...sources.resolveAgentLaunchEnv?.('claude') }
    const args = Promise.resolve(resolveArgs()).then((value) => claudeStructuredLaunchArgs(value))
    const inherited = sources.resolveBaseEnvironment().then((value) => ({ ...value }))
    const pinned = agentSessionPinnedLaunchDirectory(record)
    const directory = pinned
      ? Promise.resolve(pinned)
      : sources.resolveWorkspacePath(record.location.workspaceId)
    const router = getClaudeProfileRouter()
    const policy = router?.preparation()
    const systemHome = router?.systemDefaultHome()
    const savedHome = requireLegacyAgentSessionAccountHome(record.accountHome).path
    return (async () => {
      const [cwd, baseEnv, configuredArgs] = await Promise.all([directory, inherited, args])
      const resolved = await resolveClaudeChildEnvSources({
        resolveEnv: () => overlay,
        resolveInheritedEnv: () => Promise.resolve(baseEnv),
        resolveWorkingDirectory: () => cwd,
        ...(settings
          ? {
              resolveCommand: (options) =>
                resolveStructuredAgentCommand('claude', settings, options)
            }
          : resolveCommand
            ? { resolveCommand }
            : {})
      })
      const env = claudeChildEnv(resolved, undefined, { runtimeOnPath: false })
      const home = policy
        ? policy.provenance === 'system'
          ? env.CLAUDE_CONFIG_DIR?.trim() || systemHome || policy.configDir
          : policy.configDir
        : savedHome
      if (policy) {
        applyClaudeEnvPatch(env, policy.envPatch)
      }
      Object.assign(env, claudeConfigDirEnvPatch(home, { env }))
      return {
        command: resolved.command,
        cwd,
        home: resolve(cwd, home),
        env,
        extraArgs: configuredArgs.extraArgs
      }
    })()
  }
}

/** Owned contexts always use their actual launch, including its account and configured args. */
export function claudeNamingLaunchInputs(launch: ClaudeStructuredLaunch): ClaudeNamingInputs {
  const env = buildClaudeChildProcessEnv(
    {
      ...launch.env,
      ...claudeConfigDirEnvPatch(launch.claudeConfigDir, { env: launch.env })
    },
    {
      inheritedEnv: withoutInheritedClaudeConfigDir(process.env),
      scrubConfiguredChildSessionStamps: true
    }
  )
  for (const key of launch.envToDelete ?? []) {
    delete env[key]
  }
  return {
    command: launch.pathToClaudeCodeExecutable,
    cwd: launch.cwd,
    home: resolve(launch.cwd, launch.claudeConfigDir),
    env,
    extraArgs: { ...launch.options.extraArgs }
  }
}
