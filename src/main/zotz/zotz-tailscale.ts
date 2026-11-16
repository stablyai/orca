import { delimiter, join, win32 } from 'node:path'
import type { ZotzTailscaleStatus } from '../../shared/zotz/zotz-node-setup-contract'
import { isJsonRecord, parseJsonRecord } from './zotz-json-record'
import { processOutput, type ZotzProcessRunner } from './zotz-process-runner'

export type ZotzTailscaleEnvironment = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  run: ZotzProcessRunner
  exists: (path: string) => Promise<boolean>
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

async function firstExisting(
  environment: ZotzTailscaleEnvironment,
  candidates: readonly string[]
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await environment.exists(candidate)) {
      return candidate
    }
  }
  return null
}

export function findTailscaleCli(environment: ZotzTailscaleEnvironment): Promise<string | null> {
  return firstExisting(environment, tailscaleCliCandidates(environment.platform, environment.env))
}

/** `tailscale status --json`: only a Running backend has a usable tailnet address. */
export function parseTailscaleStatusJson(json: string): Omit<ZotzTailscaleStatus, 'installed'> {
  const parsed = parseJsonRecord(json)
  if (!parsed) {
    return { running: false, ip: null, authUrl: null }
  }
  const self = isJsonRecord(parsed.Self) ? parsed.Self : {}
  const ips: unknown[] = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []
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
  const cli = await findTailscaleCli(environment)
  if (!cli) {
    return { installed: false, running: false, ip: null, authUrl: null }
  }
  // A stopped daemon exits non-zero; the IP is read live each time because re-registering changes it.
  const result = await environment.run(cli, ['status', '--json'], STATUS_TIMEOUT_MS)
  return { installed: true, ...parseTailscaleStatusJson(result.stdout) }
}

type InstallCommand = { program: string; args: string[] }

/** Ordered attempts; the first that exits 0 wins. Empty means the user must install by hand. */
export async function tailscaleInstallCommands(
  environment: ZotzTailscaleEnvironment
): Promise<InstallCommand[]> {
  if (environment.platform === 'win32') {
    const localAppData = environment.env.LOCALAPPDATA
    const winget = localAppData
      ? win32.join(localAppData, 'Microsoft', 'WindowsApps', 'winget.exe')
      : null
    return winget && (await environment.exists(winget))
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
    const brew = await firstExisting(environment, ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'])
    // Homebrew renamed the GUI cask from `tailscale` to `tailscale-app`.
    return brew
      ? [
          { program: brew, args: ['install', '--cask', 'tailscale-app'] },
          { program: brew, args: ['install', '--cask', 'tailscale'] }
        ]
      : []
  }
  return (await environment.exists('/usr/bin/pkexec'))
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
  const commands = await tailscaleInstallCommands(environment)
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
