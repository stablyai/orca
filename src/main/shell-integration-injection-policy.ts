export type ShellIntegrationHostClass =
  | 'local-native'
  | 'local-wsl'
  | 'daemon-native'
  | 'daemon-wsl'

const DISABLE_ENV_BY_HOST_CLASS: Record<ShellIntegrationHostClass, string> = {
  'local-native': 'ORCA_DISABLE_SHELL_COMMAND_MARKERS_LOCAL_NATIVE',
  'local-wsl': 'ORCA_DISABLE_SHELL_COMMAND_MARKERS_LOCAL_WSL',
  'daemon-native': 'ORCA_DISABLE_SHELL_COMMAND_MARKERS_DAEMON_NATIVE',
  'daemon-wsl': 'ORCA_DISABLE_SHELL_COMMAND_MARKERS_DAEMON_WSL'
}

export function isShellCommandMarkerInjectionEnabled(
  hostClass: ShellIntegrationHostClass,
  hostEnv: NodeJS.ProcessEnv = process.env
): boolean {
  return hostEnv[DISABLE_ENV_BY_HOST_CLASS[hostClass]] !== '1'
}

export function scrubShellCommandMarkerPolicyEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.values(DISABLE_ENV_BY_HOST_CLASS)) {
    delete env[key]
  }
}

export function resolvePowerShellCommandMarkerTrust(
  platform: NodeJS.Platform,
  osRelease: string
): boolean {
  if (platform !== 'win32') {
    return true
  }
  const build = Number(osRelease.split('.')[2])
  return Number.isSafeInteger(build) && build >= 22_000
}
