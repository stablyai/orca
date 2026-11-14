import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { resolveProviderChildEnv, type ProviderProcessLaunch } from './provider-process-launch'

export const PROVIDER_STDIN_END_GRACE_MS = 1_000
export const PROVIDER_SIGTERM_GRACE_MS = 3_000
export const PROVIDER_BRIEF_SIGTERM_GRACE_MS = 1_000
/** Lifecycle control, never a signal to the provider executable. */
export const PROVIDER_SUPERVISOR_REAP_NOW_SIGNAL = 'SIGUSR2'
export const PROVIDER_GROUP_REAP_TIMEOUT_MS = 1_500
export const PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS = 1_000
export const PROVIDER_SUPERVISOR_MAX_STOP_MS =
  PROVIDER_STDIN_END_GRACE_MS +
  PROVIDER_SIGTERM_GRACE_MS +
  PROVIDER_GROUP_REAP_TIMEOUT_MS +
  PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS

export type ProviderSupervisorLifetime = 'session' | 'one-shot'
export type ProviderCloseRequest = 'stdin-end' | 'stdin-end-and-sigterm'
export type ProviderSupervisorOptions = {
  lifetime?: ProviderSupervisorLifetime
  closeRequest?: ProviderCloseRequest
  stdinEndGraceMs?: number
  sigtermGraceMs?: number
}

export function resolveProviderExecPath(platform: NodeJS.Platform = process.platform): string {
  const app = getAppEnvironment()
  if (!app.isPackaged()) {
    return join(
      app.getAppPath(),
      'native',
      'provider-exec',
      '.build',
      `${platform}-${process.arch}`,
      'orca-provider-exec'
    )
  }
  if (process.resourcesPath) {
    return platform === 'darwin'
      ? join(process.resourcesPath, '..', 'MacOS', 'orca-provider-exec')
      : join(process.resourcesPath, 'bin', 'orca-provider-exec')
  }
  return join(app.getAppPath(), 'bin', 'orca-provider-exec')
}

export function createProviderSpawnSpec(
  launch: ProviderProcessLaunch,
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  {
    lifetime = 'session',
    closeRequest = 'stdin-end-and-sigterm',
    stdinEndGraceMs = PROVIDER_STDIN_END_GRACE_MS,
    sigtermGraceMs = PROVIDER_SIGTERM_GRACE_MS
  }: ProviderSupervisorOptions = {}
) {
  for (const [name, value, max] of [
    ['stdin-end', stdinEndGraceMs, PROVIDER_STDIN_END_GRACE_MS],
    ['SIGTERM', sigtermGraceMs, PROVIDER_SIGTERM_GRACE_MS]
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new RangeError(`Provider ${name} grace ${value} ms is outside 0-${max} ms`)
    }
  }
  const supervised = platform !== 'win32'
  return {
    program: supervised ? resolveProviderExecPath(platform) : launch.command,
    args: supervised
      ? [
          String(stdinEndGraceMs),
          String(sigtermGraceMs),
          lifetime,
          closeRequest,
          '--',
          launch.command,
          ...launch.args
        ]
      : launch.args,
    command: launch.command,
    env: resolveProviderChildEnv(launch, baseEnv),
    cwd: launch.cwd ?? process.cwd(),
    detached: supervised,
    supervised,
    lifetime,
    closeRequest,
    stdinEndGraceMs,
    sigtermGraceMs
  }
}

export type ProviderSpawnSpec = ReturnType<typeof createProviderSpawnSpec>
