import { parseWslUncPath, toLinuxPath } from '../../../shared/file-access/wsl-paths'
import {
  getOpenCodeCliCapabilities,
  type OpenCodeCliCapabilities
} from '../../../shared/agent-launch/startup/opencode-cli-version'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { resolveCommandOnLocalPath } from '../../ipc/command-path/command-path-resolver'
import { runWslProcess } from '../../wsl/execution/wsl-runner'
import { probeOpenCodeCliVersion } from './opencode-cli-version'
import type { AgentStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { getAgentLaunchCommandToken } from '../../../shared/agent-launch/startup/agent-command-line-intent'
import { launchExecutableIs } from '../../../shared/agent-launch/startup/launch-position'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../../shared/shell/command-resolution/command-token-scanner'

export function getOpenCodeLaunchExecutable(
  command: string | undefined,
  agent?: TuiAgent,
  shell?: AgentStartupShell
): string | null {
  const designated = agent === 'opencode' || agent === 'opencode2'
  if (
    !designated &&
    (agent || !/opencode/i.test(command?.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS) ?? ''))
  ) {
    return null
  }
  const executable = getAgentLaunchCommandToken(command, shell)
  return executable &&
    (designated || launchExecutableIs(executable, /^opencode2?(\.(exe|cmd|bat|ps1|sh))?$/i))
    ? executable
    : null
}

export async function probeOpenCodeLaunchCapabilities(options: {
  command: string | undefined
  agent?: TuiAgent
  shell?: AgentStartupShell
  env: NodeJS.ProcessEnv
  cwd?: string
  wsl?: { distro?: string }
  hostIdentity?: string
  resolveExecutable?: (executable: string) => Promise<string | null>
}): Promise<OpenCodeCliCapabilities | null> {
  const executable = getOpenCodeLaunchExecutable(options.command, options.agent, options.shell)
  if (!executable) {
    return null
  }
  if (options.wsl) {
    // An empty carrier prevents the runner from restoring deleted ambient imports.
    const guestEnv: Record<string, string> = { WSLENV: '' }
    const wslEnv = options.env.WSLENV?.split(':')
      .filter((token) => options.env[token.split('/')[0]] !== undefined)
      .join(':')
    if (wslEnv) {
      guestEnv.WSLENV = wslEnv
      for (const token of wslEnv.split(':')) {
        const [key, flags = ''] = token.split('/')
        if (!key || flags.includes('w') || ['PATH', 'HOME', 'TMP', 'TEMP'].includes(key)) {
          continue
        }
        const value = options.env[key]
        if (value !== undefined) {
          guestEnv[key] = value
        }
      }
    }
    const wslPath = options.cwd ? parseWslUncPath(options.cwd) : null
    const cwd = options.cwd ? (wslPath?.linuxPath ?? toLinuxPath(options.cwd)) : undefined
    if (cwd !== undefined && !cwd.startsWith('/')) {
      return getOpenCodeCliCapabilities(null)
    }
    const distro = wslPath?.distro ?? options.wsl.distro
    return probeOpenCodeCliVersion({
      executablePath: executable,
      env: guestEnv,
      cwd,
      hostIdentity: `${options.hostIdentity ?? 'local'}:wsl:${distro ?? 'default'}`,
      execute: async () => {
        const result = await runWslProcess({
          distro,
          loginPath: 'preferred',
          cwd,
          program: executable,
          args: ['--version'],
          env: guestEnv,
          timeoutMs: 5_000,
          maxOutputBytes: 4_096
        })
        return result.environmentResolved ? result : { ...result, code: null }
      }
    })
  }
  const executablePath = options.resolveExecutable
    ? await options.resolveExecutable(executable)
    : await resolveCommandOnLocalPath(executable, {
        env: options.env,
        cwd: options.cwd
      })
  return executablePath
    ? probeOpenCodeCliVersion({
        executablePath,
        env: options.env,
        cwd: options.cwd,
        hostIdentity: options.hostIdentity
      })
    : getOpenCodeCliCapabilities(null)
}
