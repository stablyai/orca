import { buildClaudeResumeLaunchCommand } from '../../../shared/agent-resume-launch-command'
import type { AgentStartupSettings } from '../../../shared/agent-startup-plan-inputs'
import { runProcess, type ProcessSpec } from '../../../shared/child-process/run-process'
import { mergeCommandEnvironment } from '../../../shared/command-environment'
import { resolveAgentBaseLaunchCommand } from '../../../shared/tui-agent-launch-command'
import { resolveTuiAgentLaunchEnv } from '../../../shared/tui-agent-launch-defaults'
import { resolveStartupShell } from '../../../shared/tui-agent-startup-shell'
import { getCmdExePath } from '../../../shared/windows-batch-spawn'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { resolveProfileLoadingShell } from '../../startup/hydrate-shell-path'

const CLAUDE_HELP_TIMEOUT_MS = 10_000

export type ClaudeHelpFlagProbeHost = {
  run: typeof runProcess
  platform: NodeJS.Platform
  /** The profile-loading shell a local pane runs, or null when none can run a command headless. */
  profileShell: () => string | null
}

type ClaudeHelpInvocation = Pick<ProcessSpec, 'program' | 'args' | 'windowsVerbatimArguments'> & {
  env: Record<string, string>
}

const LOCAL_HOST: ClaudeHelpFlagProbeHost = {
  run: runProcess,
  platform: process.platform,
  profileShell: resolveProfileLoadingShell
}

/**
 * Resolves whether `--help` of the claude command a local resume types advertises `flag`, typed
 * into the same shell family with the same agent env so expansions and call operators resolve
 * the binary resume would run. Cached per invocation so a changed override, env, or shell
 * re-probes; a CLI that cannot run, or a shell Orca cannot run headless, reads as unadvertised.
 */
export function createClaudeHelpFlagProbe(
  flag: string,
  readSettings: () => AgentStartupSettings,
  host: ClaudeHelpFlagProbeHost = LOCAL_HOST
): () => Promise<boolean> {
  const advertisedByInvocation = new Map<string, Promise<boolean>>()
  return () => {
    const invocation = claudeHelpInvocation(readSettings(), host)
    if (!invocation) {
      return Promise.resolve(false)
    }
    const key = JSON.stringify(invocation)
    let advertised = advertisedByInvocation.get(key)
    if (!advertised) {
      advertised = host
        .run({
          ...invocation,
          env: mergeCommandEnvironment(undefined, invocation.env, host.platform),
          timeoutMs: CLAUDE_HELP_TIMEOUT_MS
        })
        .then((result) => result.code === 0 && result.stdout.includes(flag))
        .catch(() => false)
      advertisedByInvocation.set(key, advertised)
    }
    return advertised
  }
}

function claudeHelpInvocation(
  settings: AgentStartupSettings,
  host: ClaudeHelpFlagProbeHost
): ClaudeHelpInvocation | null {
  const { platform } = host
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings.terminalWindowsShell
    })
  )
  const command = buildClaudeResumeLaunchCommand(
    resolveAgentBaseLaunchCommand({
      agent: 'claude',
      cmdOverrides: settings.agentCmdOverrides ?? {},
      platform
    }),
    ['--help'],
    shell
  )
  const env = resolveTuiAgentLaunchEnv('claude', settings.agentDefaultEnv)
  if (shell === 'cmd') {
    return {
      program: getCmdExePath(),
      args: ['/s', '/c', `"${command}"`],
      windowsVerbatimArguments: true,
      env
    }
  }
  const program = host.profileShell()
  if (!program) {
    return null
  }
  return {
    program,
    args: shell === 'powershell' ? ['-NoLogo', '-Command', command] : ['-ilc', command],
    env
  }
}
