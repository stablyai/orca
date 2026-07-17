import type { SshTarget } from '../../shared/ssh-types'
import { getControlSocketPath, type SystemSshResolvedConfig } from './ssh-control-socket'

export type SystemSshBuildArgsOptions = {
  resolvedConfig?: SystemSshResolvedConfig | null
  disableControlMaster?: boolean
  suppressOrcaControlMaster?: boolean
  noInput?: boolean
  strictKnownHostsFile?: string
}

export function buildSshArgs(target: SshTarget, options?: SystemSshBuildArgsOptions): string[] {
  const args: string[] = []

  args.push('-o', 'BatchMode=no')
  // Forward stdin/stdout for relay communication
  args.push('-T')
  if (options?.noInput === true) {
    // Why: closing a parent pipe does not reliably detach native Windows
    // OpenSSH's input worker for commands that can never consume stdin.
    args.push('-n')
  }
  if (options?.strictKnownHostsFile) {
    // Why: native fixtures need explicit pinned trust because Win32-OpenSSH ignores HOME overrides.
    args.push(
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${options.strictKnownHostsFile}`
    )
  }

  // Why: ControlMaster multiplexes all SSH exec commands over a single connection,
  // eliminating the ~9s handshake overhead per command. Without this, each
  // spawnSystemSshCommand call opens a new TCP connection.
  const forceDisableControlMaster =
    options?.disableControlMaster === true || target.systemSshConnectionReuse === false
  const controlPath = getOrcaControlSocketPath(target, options)
  if (forceDisableControlMaster) {
    // Why: muxed OpenSSH forwards remain registered on the master after the
    // client exits. Also honors the per-target compatibility opt-out even if
    // a broad Host * ssh_config block enables multiplexing.
    args.push('-S', 'none')
  } else if (controlPath) {
    args.push('-o', 'ControlMaster=auto')
    args.push('-o', `ControlPath=${controlPath}`)
    // Why: keep master alive 300s after last command so rapid reconnects
    // (e.g. on tab focus) skip re-handshake without holding a process open.
    args.push('-o', 'ControlPersist=300')
    args.push('-o', 'ServerAliveInterval=15')
    args.push('-o', 'ServerAliveCountMax=3')
  }

  const useConfigHost = shouldUseOpenSshConfigHost(target)

  if (!useConfigHost && target.port !== 22) {
    args.push('-p', String(target.port))
  }

  if (!useConfigHost && target.identityFile) {
    args.push('-i', target.identityFile)
  }

  if (!useConfigHost && target.identityAgent) {
    args.push('-o', `IdentityAgent=${target.identityAgent}`)
  }

  if (!useConfigHost && target.identitiesOnly) {
    args.push('-o', 'IdentitiesOnly=yes')
  }

  if (!useConfigHost && target.jumpHost) {
    args.push('-J', target.jumpHost)
  }

  if (!useConfigHost && target.proxyCommand) {
    args.push('-o', `ProxyCommand=${target.proxyCommand}`)
  }

  const host = target.configHost || target.host
  const userHost = target.username ? `${target.username}@${host}` : host
  args.push('--', userHost)

  return args
}

export function getOrcaControlSocketPath(
  target: SshTarget,
  options?: SystemSshBuildArgsOptions
): string | null {
  if (shouldDisableOrcaControlMaster(target, options)) {
    return null
  }
  return getControlSocketPath(target, options?.resolvedConfig)
}

export function getSystemSshBuildArgsFromOperationOptions(
  options: SystemSshBuildArgsOptions | undefined
): SystemSshBuildArgsOptions | undefined {
  const buildArgsOptions: SystemSshBuildArgsOptions = {}
  if (options?.resolvedConfig !== undefined) {
    buildArgsOptions.resolvedConfig = options.resolvedConfig
  }
  if (options?.disableControlMaster === true) {
    buildArgsOptions.disableControlMaster = true
  }
  if (options?.suppressOrcaControlMaster === true) {
    buildArgsOptions.suppressOrcaControlMaster = true
  }
  if (options?.noInput === true) {
    buildArgsOptions.noInput = true
  }
  if (options?.strictKnownHostsFile) {
    buildArgsOptions.strictKnownHostsFile = options.strictKnownHostsFile
  }
  return Object.keys(buildArgsOptions).length === 0 ? undefined : buildArgsOptions
}

function shouldDisableOrcaControlMaster(
  target: SshTarget,
  options?: SystemSshBuildArgsOptions
): boolean {
  // Why: unresolved ssh_config aliases could otherwise share one Orca socket
  // while OpenSSH routes them through mutable HostName/ProxyJump settings.
  const unresolvedConfigBackedTarget =
    isOpenSshConfigBackedTarget(target) && options?.resolvedConfig == null
  return (
    options?.disableControlMaster === true ||
    options?.suppressOrcaControlMaster === true ||
    target.systemSshConnectionReuse === false ||
    unresolvedConfigBackedTarget ||
    hasUserConfiguredControlMaster(options?.resolvedConfig)
  )
}

function hasUserConfiguredControlMaster(
  resolvedConfig: SystemSshResolvedConfig | null | undefined
): boolean {
  if (!resolvedConfig) {
    return false
  }
  // Why: ControlPersist/ControlPath alone can reuse a master someone else
  // created, but they do not create the setup-burst master Orca needs.
  return (
    hasEnabledControlMaster(resolvedConfig.controlMaster) &&
    hasEnabledControlPath(resolvedConfig.controlPath)
  )
}

function hasEnabledControlMaster(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return (
    normalized != null &&
    normalized !== '' &&
    normalized !== '0' &&
    normalized !== 'no' &&
    normalized !== 'false'
  )
}

function hasEnabledControlPath(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized != null && normalized !== '' && normalized !== 'none'
}

function shouldUseOpenSshConfigHost(target: SshTarget): boolean {
  if (!target.configHost) {
    return false
  }
  return isOpenSshConfigBackedTarget(target)
}

function isOpenSshConfigBackedTarget(target: SshTarget): boolean {
  if (target.source === 'ssh-config') {
    return true
  }
  if (target.source === 'manual') {
    return false
  }
  // Why: legacy imported aliases have a distinct configHost; manual targets
  // historically stored configHost=host and still need explicit -p/-i args.
  return Boolean(target.configHost && target.configHost !== target.host)
}
