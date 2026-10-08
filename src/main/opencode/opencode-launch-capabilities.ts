import { parseWslUncPath, toLinuxPath } from '../../shared/wsl-paths'
import {
  getFirstCommandToken,
  getCommandTokenPathBasename
} from '../../shared/command-token-scanner'
import {
  getOpenCodeCliCapabilities,
  type OpenCodeCliCapabilities
} from '../../shared/opencode-cli-version'
import type { TuiAgent } from '../../shared/tui-agent'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { runWslProcess } from '../wsl/wsl-runner'
import { probeOpenCodeCliVersion } from './opencode-cli-version'

export function getOpenCodeLaunchExecutable(
  command: string | undefined,
  agent?: TuiAgent
): string | null {
  const executable = getFirstCommandToken(command ?? '')
  const name = getCommandTokenPathBasename(executable)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|sh)$/, '')
  return agent === 'opencode' ||
    agent === 'opencode2' ||
    (!agent && (name === 'opencode' || name === 'opencode2'))
    ? executable || null
    : null
}

export async function probeOpenCodeLaunchCapabilities(options: {
  command: string | undefined
  agent?: TuiAgent
  env: NodeJS.ProcessEnv
  cwd?: string
  wsl?: { distro?: string }
  hostIdentity?: string
  resolveExecutable?: (executable: string) => Promise<string | null>
}): Promise<OpenCodeCliCapabilities | null> {
  const executable = getOpenCodeLaunchExecutable(options.command, options.agent)
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
    : await resolveCommandOnLocalPath(executable, { env: options.env, cwd: options.cwd })
  return executablePath
    ? probeOpenCodeCliVersion({
        executablePath,
        env: options.env,
        cwd: options.cwd,
        hostIdentity: options.hostIdentity
      })
    : getOpenCodeCliCapabilities(null)
}
