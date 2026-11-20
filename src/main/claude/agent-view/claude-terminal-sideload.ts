import { delimiter } from 'node:path'
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
import { getWslGuestEnvironment } from '../../wsl/execution/wsl-guest-environment'
import { blockedWslDistroForExec } from '../../wsl/discovery/wsl-background-exec-gate'
import {
  claudeCliFlagSupport,
  type ClaudeCliLaunch
} from '../cli-capabilities/claude-cli-flag-support'

const TIMEOUT_MS = 5_000

type TerminalLaunch = {
  command?: string
  cwd?: string
  env: Record<string, string>
  shell: AgentStartupShell
  wsl?: { distro?: string }
}

export async function prepareClaudeTerminalLaunch(
  input: TerminalLaunch
): Promise<string | undefined> {
  await prepareClaudeTerminalSideload(input)
  const root = input.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR
  return root && input.command
    ? withClaudeAgentViewPlugin(input.command, root, input.shell)
    : input.command
}

async function resolveLaunch(input: TerminalLaunch): Promise<ClaudeCliLaunch | null> {
  let executable = 'claude'
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...input.env }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )
  const assigned: Record<string, string> = {}
  if (input.command) {
    if (withClaudeAgentViewPlugin(input.command, 'orca-probe', input.shell) === input.command) {
      return null
    }
    const parsed = tokenizeStartupCommand(input.command, input.shell)
    if (!parsed.ok) {
      return null
    }
    const index = findClaudeExecutableIndex(parsed.tokens, input.shell)
    executable = parsed.tokens[index]
    for (const token of parsed.tokens.slice(0, index)) {
      const at = token.indexOf('=')
      if (at > 0) {
        env[token.slice(0, at)] = token.slice(at + 1)
        assigned[token.slice(0, at)] = token.slice(at + 1)
      }
    }
  }
  if (!input.wsl) {
    const cwd = input.cwd ?? process.cwd()
    const command = await resolveCommandOnLocalPath(executable, { env, cwd })
    return command ? { command, cwd, env } : null
  }
  const unc = input.cwd ? parseWslUncPath(input.cwd) : null
  const distro = unc?.distro ?? input.wsl.distro
  if (await blockedWslDistroForExec(distro)) {
    return null
  }
  const guest = await getWslGuestEnvironment(distro, TIMEOUT_MS)
  if (!guest) {
    return null
  }
  const cwd = input.cwd ? (unc?.linuxPath ?? toLinuxPath(input.cwd)) : guest.home
  if (!cwd.startsWith('/')) {
    return null
  }
  const guestEnv: Record<string, string> = { WSLENV: '' }
  for (const token of env.WSLENV?.split(':') ?? []) {
    const [key, flags = ''] = token.split('/')
    if (
      !flags.includes('w') &&
      !['PATH', 'HOME', 'TMP', 'TEMP'].includes(key) &&
      env[key] !== undefined
    ) {
      guestEnv[key] = env[key]
    }
  }
  // These account overrides are already guest paths; never import the Windows default home.
  for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_DIRS']) {
    const value = assigned[key] ?? input.env[key]
    if (value !== undefined) {
      guestEnv[key] = value
    }
  }
  const identity = await runWslProcess({
    distro,
    loginPath: 'preferred',
    cwd,
    env: guestEnv,
    script:
      'p=$(command -v "$1") || exit 1; p=$(readlink -f "$p") || exit 1; printf "%s\\n" "$p"; stat -c "%Y:%s:%i" "$p"',
    args: [executable],
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: 4096
  })
  const [command, stamp] = identity.stdout.trim().split('\n')
  if (identity.code !== 0 || !identity.environmentResolved || !command?.startsWith('/') || !stamp) {
    return null
  }
  return {
    command,
    cwd,
    env: { ...guestEnv, CLAUDE_CONFIG_DIR: guestEnv.CLAUDE_CONFIG_DIR || `${guest.home}/.claude` },
    binaryKey: JSON.stringify(['wsl', distro ?? 'default', command, stamp, cwd])
  }
}

/** Probe before delivering a terminal command: its shell outlives a refused Claude process. */
export async function prepareClaudeTerminalSideload(
  input: TerminalLaunch,
  deps = { resolveLaunch, support: claudeCliFlagSupport, runProcess, runWslProcess }
): Promise<void> {
  const root = input.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR
  if (!root) {
    return
  }
  try {
    const launch = await deps.resolveLaunch(input)
    if (!launch) {
      return
    }
    const fact = await deps.support.probeSideload?.(launch, () =>
      runClaudeBackgroundAttempts({
        agentId: 'claude',
        run: async (strictMcp) => {
          const args = ['--plugin-dir', root, '--print', ...claudeBackgroundArgs(strictMcp)]
          return input.wsl
            ? deps.runWslProcess({
                distro:
                  (input.cwd ? parseWslUncPath(input.cwd)?.distro : undefined) ?? input.wsl.distro,
                loginPath: 'preferred',
                cwd: launch.cwd,
                program: launch.command,
                args,
                env: launch.env,
                input: '',
                timeoutMs: TIMEOUT_MS,
                maxOutputBytes: 8192
              })
            : deps.runProcess({
                program: launch.command,
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
    )
    if (fact !== 'unsupported') {
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
  } catch {
    // Unrelated startup failures do not prove that the optional plugin was refused.
  }
}
