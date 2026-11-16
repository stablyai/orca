import { existsSync } from 'node:fs'
import { delimiter, join, win32 } from 'node:path'
import type { ZotzTailscaleStatus } from '../../shared/zotz/zotz-node-setup-contract'
import { processOutput, type ZotzProcessRunner } from './zotz-process-runner'

export type ZotzTailscaleEnvironment = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  run: ZotzProcessRunner
  exists?: (path: string) => boolean
}

const STATUS_TIMEOUT_MS = 10_000

function pathCandidates(env: NodeJS.ProcessEnv, fileName: string): string[] {
  return (env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .filter((dir) => dir.length > 0)
    .map((dir) => join(dir, fileName))
}

/** Absolute paths only: Windows resolves a bare name in the spawn cwd before PATH. */
export function tailscaleCliCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    return [
      win32.join(programFiles, 'Tailscale', 'tailscale.exe'),
      ...pathCandidates(env, 'tailscale.exe')
    ]
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/opt/homebrew/bin/tailscale',
      '/usr/local/bin/tailscale',
      ...pathCandidates(env, 'tailscale')
    ]
  }
  return ['/usr/bin/tailscale', '/usr/local/bin/tailscale', ...pathCandidates(env, 'tailscale')]
}

export function findTailscaleCli(environment: ZotzTailscaleEnvironment): string | null {
  const exists = environment.exists ?? existsSync
  return (
    tailscaleCliCandidates(environment.platform, environment.env).find((path) => exists(path)) ??
    null
  )
}

/** `tailscale status --json`: only a Running backend has a usable tailnet address. */
export function parseTailscaleStatusJson(json: string): Omit<ZotzTailscaleStatus, 'installed'> {
  let parsed: { BackendState?: unknown; AuthURL?: unknown; Self?: { TailscaleIPs?: unknown } }
  try {
    parsed = JSON.parse(json) as typeof parsed
  } catch {
    return { running: false, ip: null, authUrl: null }
  }
  const ips = Array.isArray(parsed.Self?.TailscaleIPs) ? parsed.Self.TailscaleIPs : []
  const ip =
    ips.find((value): value is string => typeof value === 'string' && value.startsWith('100.')) ??
    null
  const running = parsed.BackendState === 'Running' && ip !== null
  const authUrl =
    typeof parsed.AuthURL === 'string' && parsed.AuthURL.startsWith('https://')
      ? parsed.AuthURL
      : null
  return { running, ip: running ? ip : null, authUrl }
}

export async function readTailscaleStatus(
  environment: ZotzTailscaleEnvironment
): Promise<ZotzTailscaleStatus> {
  const cli = findTailscaleCli(environment)
  if (!cli) {
    return { installed: false, running: false, ip: null, authUrl: null }
  }
  // A stopped daemon exits non-zero; the IP is read live each time because re-registering changes it.
  const result = await environment.run(cli, ['status', '--json'], STATUS_TIMEOUT_MS)
  return { installed: true, ...parseTailscaleStatusJson(result.stdout) }
}

type InstallCommand = { program: string; args: string[] }

function homebrew(exists: (path: string) => boolean): string | null {
  return ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((path) => exists(path)) ?? null
}

/** Ordered attempts; the first that exits 0 wins. Empty means the user must install by hand. */
export function tailscaleInstallCommands(environment: ZotzTailscaleEnvironment): InstallCommand[] {
  const exists = environment.exists ?? existsSync
  if (environment.platform === 'win32') {
    const localAppData = environment.env.LOCALAPPDATA
    const winget = localAppData
      ? win32.join(localAppData, 'Microsoft', 'WindowsApps', 'winget.exe')
      : null
    return winget && exists(winget)
      ? [
          {
            program: winget,
            args: [
              'install',
              '--id',
              'Tailscale.Tailscale',
              '-e',
              '--silent',
              '--accept-source-agreements',
              '--accept-package-agreements'
            ]
          }
        ]
      : []
  }
  if (environment.platform === 'darwin') {
    const brew = homebrew(exists)
    // Homebrew renamed the GUI cask from `tailscale` to `tailscale-app`.
    return brew
      ? [
          { program: brew, args: ['install', '--cask', 'tailscale-app'] },
          { program: brew, args: ['install', '--cask', 'tailscale'] }
        ]
      : []
  }
  return exists('/usr/bin/pkexec')
    ? [
        {
          program: '/usr/bin/pkexec',
          args: ['/bin/sh', '-c', 'curl -fsSL https://tailscale.com/install.sh | sh']
        }
      ]
    : []
}

export function tailscaleDownloadUrl(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? 'https://tailscale.com/download/windows'
    : platform === 'darwin'
      ? 'https://tailscale.com/download/mac'
      : 'https://tailscale.com/download/linux'
}

export async function installTailscale(
  environment: ZotzTailscaleEnvironment
): Promise<{ ok: boolean; detail: string }> {
  const commands = tailscaleInstallCommands(environment)
  let detail = 'no supported installer found (winget, Homebrew or pkexec)'
  for (const command of commands) {
    const result = await environment.run(command.program, command.args, 15 * 60_000)
    if (result.code === 0) {
      return { ok: true, detail: 'installed' }
    }
    detail = processOutput(result).split('\n').slice(-3).join(' ') || `exit ${String(result.code)}`
  }
  return { ok: false, detail }
}
