import type { PtyOrchestrationCliCommand } from './pty-orchestration-cli-command'

export type SshRemoteCliBridgeEnv = {
  binDir: string
  relayDir: string
  nodePath: string
  sockPath: string
  orchestrationLauncherPath?: string
  pathDelimiter?: ':' | ';'
}

export function prependSshRemoteCliBin(
  pathValue: string,
  binDir: string,
  delimiter: ':' | ';'
): string {
  const normalize =
    delimiter === ';' ? (value: string) => value.toLowerCase() : (value: string) => value
  const normalizedBinDir = normalize(binDir)
  const remaining = pathValue
    .split(delimiter)
    .filter((entry) => normalize(entry) !== normalizedBinDir)
  return [binDir, ...remaining].join(delimiter)
}

export function mergeSshRemoteCliBridgeEnv(
  env: Record<string, string> | undefined,
  bridge: SshRemoteCliBridgeEnv | undefined
): Record<string, string> {
  const merged = { ...env }
  if (!bridge) {
    return merged
  }
  const pathDelimiter = bridge.pathDelimiter ?? ':'
  const pathKey = merged.PATH !== undefined ? 'PATH' : merged.Path !== undefined ? 'Path' : null
  if (pathKey) {
    const pathValue = merged[pathKey] ?? ''
    merged[pathKey] = pathValue
      ? prependSshRemoteCliBin(pathValue, bridge.binDir, pathDelimiter)
      : bridge.binDir
  }
  if (bridge.orchestrationLauncherPath) {
    merged.ORCA_CLI_COMMAND = bridge.orchestrationLauncherPath
  }
  merged.ORCA_REMOTE_CLI_BIN_DIR = bridge.binDir
  merged.ORCA_RELAY_DIR = bridge.relayDir
  merged.ORCA_RELAY_NODE_PATH = bridge.nodePath
  merged.ORCA_RELAY_SOCKET_PATH = bridge.sockPath
  return merged
}

export function resolveSshOrchestrationCliCommand(args: {
  launcherPath?: string
  pathDelimiter: ':' | ';'
  isWsl: boolean
  shellPath: string | null
}): PtyOrchestrationCliCommand | null {
  if (!args.launcherPath) {
    return null
  }
  const shellName = args.shellPath?.replaceAll('\\', '/').split('/').pop()?.toLowerCase()
  const isPowerShell =
    shellName === 'powershell.exe' ||
    shellName === 'powershell' ||
    shellName === 'pwsh.exe' ||
    shellName === 'pwsh'
  if (args.pathDelimiter === ':') {
    return isPowerShell
      ? { kind: 'powershell-path', executablePath: args.launcherPath }
      : { kind: 'posix-path', executablePath: args.launcherPath }
  }
  if (args.isWsl || shellName === 'wsl.exe' || shellName === 'wsl') {
    return { kind: 'posix-env', variableName: 'ORCA_CLI_COMMAND' }
  }
  if (isPowerShell) {
    return { kind: 'powershell-env', variableName: 'ORCA_CLI_COMMAND' }
  }
  if (shellName === 'cmd.exe' || shellName === 'cmd') {
    return { kind: 'cmd-env', variableName: 'ORCA_CLI_COMMAND' }
  }
  if (shellName?.includes('bash') || shellName?.includes('sh')) {
    return { kind: 'posix-env', variableName: 'ORCA_CLI_COMMAND' }
  }
  // Why: unknown Windows shells have unknown invocation syntax. A bare-name
  // fallback would recreate the host-CLI collision this bridge prevents.
  return null
}
