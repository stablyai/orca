import {
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  resolveSetupAgentSequenceLaunchCommand
} from '../../../shared/agent-launch/startup/setup-agent-sequencing'
import { claudeConfigDirEnvPatch } from '../structured/launch/claude-config-dir-pin'
import { resolveCliCommandAsync } from '../../../shared/shell/command-resolution/node-cli-command-async-resolution'
import { resolveStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveWindowsShellStartupFamily } from '../../../shared/shell/launch/windows-terminal-shell'
import { delimiter, isAbsolute } from 'node:path'
import { runProcess } from '@orca/process-host'
import { withClaudeAgentViewPlugin } from '../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view-launch'
import { findClaudeExecutableIndex } from '../../../shared/agent-launch/startup/agent-resume-launch-command'
import {
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import {
  claudeBackgroundArgs,
  runClaudeBackgroundAttempts
} from '../../../shared/text-generation/launch/claude-background-run-isolation'
import { parseWslUncPath, toLinuxPath } from '../../../shared/file-access/wsl-paths'
import { resolveCommandOnLocalPath } from '../../ipc/command-path/command-path-resolver'
import { runWslProcess } from '../../wsl/execution/wsl-runner'
import { blockedWslDistroForExec } from '../../wsl/discovery/wsl-background-exec-gate'
import {
  claudeCliFlagSupport,
  type ClaudeCliLaunch
} from '../cli-capabilities/claude-cli-flag-support'

const TIMEOUT_MS = 5_000

async function resolveProbeCommand(
  command: string,
  options: { cwd: string; env: Record<string, string> }
): Promise<string | null> {
  if (command.includes('/') || command.includes('\\')) {
    return resolveCommandOnLocalPath(command, options)
  }
  const resolved = await resolveCliCommandAsync(command, {
    pathEnv: options.env.PATH ?? options.env.Path,
    homePath: options.env.HOME ?? options.env.USERPROFILE
  })
  return isAbsolute(resolved) ? resolved : null
}

type TerminalLaunch = {
  command?: string
  cwd?: string
  env: Record<string, string>
  shell: AgentStartupShell
  wsl?: { distro?: string }
}

function launchContext(input: TerminalLaunch): ClaudeCliLaunch | null {
  let command = 'claude'
  const env: Record<string, string> = input.wsl
    ? {}
    : Object.fromEntries(
        Object.entries({ ...process.env, ...input.env }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )
  if (!input.wsl && input.env.ORCA_CLAUDE_CONFIG_DIR) {
    Object.assign(env, claudeConfigDirEnvPatch(input.env.ORCA_CLAUDE_CONFIG_DIR, { env }))
  }
  if (input.wsl) {
    for (const token of input.env.WSLENV?.split(':') ?? []) {
      const [key, flags = ''] = token.split('/')
      if (
        !flags.includes('w') &&
        !['PATH', 'HOME', 'TMP', 'TEMP'].includes(key) &&
        input.env[key] !== undefined
      ) {
        env[key] = input.env[key]
      }
    }
    if (input.env.CLAUDE_CONFIG_DIR) {
      env.CLAUDE_CONFIG_DIR = input.env.CLAUDE_CONFIG_DIR
    }
    env.WSLENV = (input.env.WSLENV ?? '')
      .split(':')
      .filter((token) => {
        const [key, flags = ''] = token.split('/')
        return !flags.includes('w') && env[key] !== undefined
      })
      .join(':')
  }
  const startupCommand = resolveSetupAgentSequenceLaunchCommand(input.env, input.command)
  if (startupCommand) {
    if (withClaudeAgentViewPlugin(startupCommand, 'orca-probe', input.shell) === startupCommand) {
      return null
    }
    const parsed = tokenizeStartupCommand(startupCommand, input.shell)
    if (!parsed.ok) {
      return null
    }
    const index = findClaudeExecutableIndex(parsed.tokens, input.shell)
    command = parsed.tokens[index]
    for (const token of parsed.tokens.slice(0, index)) {
      const at = token.indexOf('=')
      if (at > 0) {
        env[token.slice(0, at)] = token.slice(at + 1)
      }
    }
  }
  const unc = input.cwd ? parseWslUncPath(input.cwd) : null
  const distro = unc?.distro ?? input.wsl?.distro
  const cwd =
    input.wsl && input.cwd
      ? (unc?.linuxPath ?? toLinuxPath(input.cwd))
      : (input.cwd ?? process.cwd())
  if (
    input.wsl &&
    (!cwd.startsWith('/') || !(env.CLAUDE_CONFIG_DIR || input.env.ORCA_CLAUDE_CONFIG_DIR))
  ) {
    return null
  }
  const configured = env.CLAUDE_CONFIG_DIR || input.env.ORCA_CLAUDE_CONFIG_DIR
  const translatesConfig =
    input.wsl &&
    env.WSLENV?.split(':').some(
      (token) => token.split('/')[0] === 'CLAUDE_CONFIG_DIR' && token.split('/')[1]?.includes('p')
    )
  return {
    command,
    cwd,
    env,
    ...(input.wsl
      ? {
          hostKey: `wsl:${distro ?? 'default'}`,
          accountConfigDir: translatesConfig && configured ? toLinuxPath(configured) : configured
        }
      : {})
  }
}

/** Only the background hook preparation runs this probe; terminal delivery never waits on it. */
export async function prewarmClaudeTerminalSideload(
  input: TerminalLaunch,
  deps = {
    support: claudeCliFlagSupport,
    runProcess,
    runWslProcess,
    resolveCommandOnLocalPath: resolveProbeCommand
  }
): Promise<void> {
  const root = input.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR
  if (!root || !resolveSetupAgentSequenceLaunchCommand(input.env, input.command)) {
    return
  }
  const launch = launchContext(input)
  if (!launch) {
    return
  }
  await deps.support.probeSideload?.(launch, async () => {
    const distro = (input.cwd ? parseWslUncPath(input.cwd)?.distro : undefined) ?? input.wsl?.distro
    if (input.wsl && (await blockedWslDistroForExec(distro))) {
      return { code: null, stdout: '', stderr: '', timedOut: true }
    }
    const command = input.wsl
      ? launch.command
      : await deps.resolveCommandOnLocalPath(launch.command, { cwd: launch.cwd, env: launch.env })
    if (!command) {
      return { code: null, stdout: '', stderr: '', timedOut: true }
    }
    return runClaudeBackgroundAttempts({
      agentId: 'claude',
      run: async (strictMcp) => {
        const args = ['--plugin-dir', root, '--print', ...claudeBackgroundArgs(strictMcp)]
        return input.wsl
          ? deps.runWslProcess({
              distro,
              loginPath: 'preferred',
              cwd: launch.cwd,
              program: command,
              args,
              env: launch.env,
              input: '',
              timeoutMs: TIMEOUT_MS,
              maxOutputBytes: 8192
            })
          : deps.runProcess({
              program: command,
              args,
              cwd: launch.cwd,
              env: launch.env,
              input: '',
              timeoutMs: TIMEOUT_MS,
              maxOutputBytes: 8192,
              terminationBarrier: true
            })
      },
      failedExit: (result) => ({
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr
      })
    })
  })
}

export function prepareClaudeTerminalSideload(
  input: TerminalLaunch,
  support = claudeCliFlagSupport
): void {
  const root = input.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR
  if (!root) {
    return
  }
  const launch = launchContext(input)
  if (!launch || !support.sideloadRefused?.(launch)) {
    return
  }
  const paths = input.env.CLAUDE_CODE_PLUGIN_DIRS
  if (paths !== undefined) {
    input.env.CLAUDE_CODE_PLUGIN_DIRS = paths
      .split(input.wsl ? ':' : delimiter)
      .filter((path) => path !== root)
      .join(input.wsl ? ':' : delimiter)
  }
  delete input.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR
  delete input.env.ORCA_CLAUDE_CONFIG_DIR
}

export function prepareClaudeTerminalLaunch(input: TerminalLaunch): string | undefined {
  prepareClaudeTerminalSideload(input)
  const root = input.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR
  if (!root || !input.command) {
    return input.command
  }
  const child = input.env[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
  if (child) {
    input.env[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV] = withClaudeAgentViewPlugin(
      child,
      root,
      input.shell
    )
    return input.command
  }
  return withClaudeAgentViewPlugin(input.command, root, input.shell)
}

export function prepareClaudeTerminalHooks(
  baseEnv: Record<string, string>,
  opts: {
    launchCommand?: string
    cwd?: string
    isWsl?: boolean
    shellPath?: string
    wslDistro?: string | null
  }
): void {
  const claudeLaunch = {
    env: baseEnv,
    command: opts.launchCommand,
    cwd: opts.cwd,
    shell: resolveStartupShell(
      opts.isWsl ? 'linux' : process.platform,
      process.platform === 'win32' ? resolveWindowsShellStartupFamily(opts.shellPath) : undefined
    ),
    ...(opts.isWsl ? { wsl: { distro: opts.wslDistro ?? undefined } } : {})
  }
  void prewarmClaudeTerminalSideload({ ...claudeLaunch, env: { ...baseEnv } }).catch(() => {})
  prepareClaudeTerminalSideload(claudeLaunch)
}
