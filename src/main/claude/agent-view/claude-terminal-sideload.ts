import { extractLeadingEnvAssignments } from '../../../shared/shell/launch/command-environment'
import {
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  resolveSetupAgentSequenceLaunchCommand
} from '../../../shared/agent-launch/startup/setup-agent-sequencing'
import { claudeConfigDirEnvPatch } from '../structured/launch/claude-config-dir-pin'
import { resolveExecutableCommandAsync } from '../../../shared/shell/command-resolution/node-cli-command-async-resolution'
import { resolveStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveWindowsShellStartupFamily } from '../../../shared/shell/launch/windows-terminal-shell'
import { delimiter, isAbsolute, resolve } from 'node:path'
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
  return resolveExecutableCommandAsync(
    /[\\/]/.test(command) && !isAbsolute(command) && !command.startsWith('~')
      ? resolve(options.cwd, command)
      : command,
    {
      pathEnv: options.env.PATH ?? options.env.Path,
      homePath: options.env.HOME ?? options.env.USERPROFILE
    }
  )
}

type TerminalLaunch = {
  command?: string
  cwd?: string
  env: Record<string, string>
  shell: AgentStartupShell
  wsl?: { distro?: string }
}

function launchContext(input: TerminalLaunch, requireDirectCommand = true): ClaudeCliLaunch | null {
  const inherited = { ...process.env, ...input.env }
  let command = 'claude'
  const env: Record<string, string> = input.wsl
    ? {}
    : Object.fromEntries(
        Object.entries(inherited).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )
  if (!input.wsl && input.env.ORCA_CLAUDE_CONFIG_DIR) {
    Object.assign(env, claudeConfigDirEnvPatch(input.env.ORCA_CLAUDE_CONFIG_DIR, { env }))
  }
  if (input.wsl) {
    for (const token of inherited.WSLENV?.split(':') ?? []) {
      const [key, flags = ''] = token.split('/')
      if (
        !flags.includes('w') &&
        !['PATH', 'HOME', 'TMP', 'TEMP'].includes(key) &&
        inherited[key] !== undefined
      ) {
        env[key] = inherited[key]!
      }
    }
    const configDirection = inherited.WSLENV?.split(':')
      .find((token) => token.split('/')[0] === 'CLAUDE_CONFIG_DIR')
      ?.split('/')[1]
    if (inherited.CLAUDE_CONFIG_DIR && !configDirection?.includes('w')) {
      env.CLAUDE_CONFIG_DIR = inherited.CLAUDE_CONFIG_DIR
    }
    env.WSLENV = inherited.WSLENV ?? ''
  }
  const startupCommand = resolveSetupAgentSequenceLaunchCommand(input.env, input.command)
  if (startupCommand) {
    const direct =
      withClaudeAgentViewPlugin(startupCommand, 'orca-probe', input.shell) !== startupCommand
    if (requireDirectCommand && !direct) {
      return null
    }
    const parsed = tokenizeStartupCommand(startupCommand, input.shell)
    if (parsed.ok) {
      if (input.shell === 'posix') {
        const outer = extractLeadingEnvAssignments(parsed.tokens)
        const inner =
          outer.rest[0]?.split('/').at(-1) === 'env'
            ? extractLeadingEnvAssignments(outer.rest.slice(1))
            : undefined
        const rest = (inner ?? outer).rest
        const prefixCount = parsed.tokens.length - rest.length
        const span = parsed.spans[prefixCount]
        const raw = span && startupCommand.slice(span.start, span.end)
        const boundary = raw?.search(/[;&|<>]/) ?? -1
        const beforeBoundary =
          boundary >= 0 ? tokenizeStartupCommand(raw!.slice(0, boundary), input.shell) : undefined
        const executable = beforeBoundary
          ? beforeBoundary.ok &&
            beforeBoundary.tokens.length === 1 &&
            !beforeBoundary.spans.some((part) => part.divergesFromShell)
            ? beforeBoundary.tokens[0]
            : undefined
          : rest[0]
        if (
          executable &&
          findClaudeExecutableIndex([executable], input.shell) === 0 &&
          !parsed.spans.slice(0, prefixCount).some((span) => span.divergesFromShell)
        ) {
          const assignments = { ...outer.env, ...inner?.env }
          if (Object.values(assignments).some((value) => /[$`]|(?:^|:)~/.test(value))) {
            return null
          }
          Object.assign(env, assignments)
          if (input.wsl) {
            env.WSLENV =
              env.WSLENV?.split(':')
                .filter((token) => !Object.hasOwn(assignments, token.split('/')[0]))
                .join(':') ?? ''
          }
        }
      }
      if (direct) {
        command = parsed.tokens[findClaudeExecutableIndex(parsed.tokens, input.shell)]
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
      return { code: null, stdout: '', stderr: '', skipped: true }
    }
    const command = input.wsl
      ? launch.command
      : await deps.resolveCommandOnLocalPath(launch.command, { cwd: launch.cwd, env: launch.env })
    if (!command) {
      return { code: null, stdout: '', stderr: '', skipped: true }
    }
    return runClaudeBackgroundAttempts({
      agentId: 'claude',
      run: async (strictMcp) => {
        if (deps.support.sideloadRefused?.(launch)) {
          return { code: 1, stdout: '', stderr: '', timedOut: false }
        }
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
  const launch = launchContext(input, false)
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
