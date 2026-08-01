import type { SshTarget } from '../../shared/ssh-types'
import { getControlSocketPath, type SystemSshResolvedConfig } from './ssh-control-socket'

export type SystemSshBuildArgsOptions = {
  configFile?: string
  resolvedConfig?: SystemSshResolvedConfig | null
  disableControlMaster?: boolean
  suppressOrcaControlMaster?: boolean
  gssapiOnly?: boolean
  nonInteractive?: boolean
}

export function buildSshArgs(target: SshTarget, options?: SystemSshBuildArgsOptions): string[] {
  const args: string[] = []

  if (options?.configFile) {
    args.push('-F', options.configFile)
  }
  args.push('-o', options?.gssapiOnly || options?.nonInteractive ? 'BatchMode=yes' : 'BatchMode=no')
  if (options?.gssapiOnly) {
    // Why: the probe must neither authenticate with a key nor open an OpenSSH
    // credential prompt; failure belongs to Orca's existing ssh2 prompt path.
    args.push('-o', 'GSSAPIAuthentication=yes')
    args.push('-o', 'PreferredAuthentications=gssapi-with-mic')
  }
  // Forward stdin/stdout for relay communication
  args.push('-T')

  // Why: ControlMaster multiplexes all SSH exec commands over a single connection,
  // eliminating the ~9s handshake overhead per command. Without this, each
  // spawnSystemSshCommand call opens a new TCP connection.
  const controlPath = getOrcaControlSocketPath(target, options)
  const forceDisableControlMaster =
    options?.disableControlMaster === true ||
    target.systemSshConnectionReuse === false ||
    (options?.gssapiOnly === true && controlPath === null)
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
  const resolvedEndpoint = getResolvedEndpoint(target, options)
  const configHost = target.configHost || target.host
  const useStoredEndpoint = shouldUseStoredEndpoint(target, resolvedEndpoint)
  const endpoint = useStoredEndpoint
    ? { hostname: target.host, port: target.port, user: target.username }
    : resolvedEndpoint

  if ((!useConfigHost && target.port !== 22) || (endpoint !== undefined && endpoint.port !== 22)) {
    args.push('-p', String(endpoint?.port ?? target.port))
  }

  if (endpoint) {
    if (endpoint.hostname && endpoint.hostname !== configHost) {
      args.push('-o', `Hostname=${endpoint.hostname}`)
    }
    if (endpoint.user && (useStoredEndpoint || endpoint.user !== target.username)) {
      args.push('-l', endpoint.user)
    }
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

  if (!useConfigHost && target.gssapiAuthentication && !options?.gssapiOnly) {
    // Why: manual targets bypass ssh_config, so Kerberos auth must be
    // requested explicitly; config-backed hosts inherit it from their entry.
    args.push('-o', 'GSSAPIAuthentication=yes')
  }

  if (!useConfigHost && target.jumpHost) {
    args.push('-J', target.jumpHost)
  }

  if (!useConfigHost && target.proxyCommand) {
    args.push('-o', `ProxyCommand=${target.proxyCommand}`)
  }

  // Why: OpenSSH owns User for config-backed aliases; imported fallback values
  // must not override a fresh wildcard, Include, or Match result.
  const userHost = useConfigHost
    ? configHost
    : target.username
      ? `${target.username}@${configHost}`
      : configHost
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
  return getControlSocketPath(target, options?.resolvedConfig, options?.gssapiOnly === true)
}

export function getSystemSshBuildArgsFromOperationOptions(
  options: SystemSshBuildArgsOptions | undefined
): SystemSshBuildArgsOptions | undefined {
  const buildArgsOptions: SystemSshBuildArgsOptions = {}
  if (options?.configFile !== undefined) {
    buildArgsOptions.configFile = options.configFile
  }
  if (options?.resolvedConfig !== undefined) {
    buildArgsOptions.resolvedConfig = options.resolvedConfig
  }
  if (options?.disableControlMaster === true) {
    buildArgsOptions.disableControlMaster = true
  }
  if (options?.suppressOrcaControlMaster === true) {
    buildArgsOptions.suppressOrcaControlMaster = true
  }
  if (options?.gssapiOnly === true) {
    buildArgsOptions.gssapiOnly = true
  }
  if (options?.nonInteractive === true) {
    buildArgsOptions.nonInteractive = true
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
    (hasUserConfiguredControlMaster(options?.resolvedConfig) && options?.gssapiOnly !== true)
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

function getResolvedEndpoint(
  target: SshTarget,
  options?: SystemSshBuildArgsOptions
): SystemSshResolvedConfig | undefined {
  if (!shouldUseOpenSshConfigHost(target) || !options?.resolvedConfig) {
    return undefined
  }

  // Why: ssh -G is the current OpenSSH authority for config-backed targets;
  // imported fields may contain schema defaults or stale concrete-block values.
  return options.resolvedConfig
}

function shouldUseStoredEndpoint(
  target: SshTarget,
  resolvedEndpoint: SystemSshResolvedConfig | undefined
): boolean {
  if (!resolvedEndpoint || !shouldUseOpenSshConfigHost(target)) {
    return false
  }

  const alias = (target.configHost || target.host).trim().toLowerCase()
  const resolvedHostname = resolvedEndpoint.hostname.trim().toLowerCase()
  const hasEffectiveProxy =
    resolvedEndpoint.proxyUseFdpass === true ||
    resolvedEndpoint.proxyCommand != null ||
    resolvedEndpoint.proxyJump != null
  if (!hasEffectiveProxy || resolvedHostname !== alias) {
    return false
  }

  // Why: a wildcard proxy can keep system SSH active after the concrete alias
  // block disappears; in that shape ssh -G returns the alias/default endpoint.
  return (
    target.host.trim().toLowerCase() !== resolvedHostname ||
    target.port !== resolvedEndpoint.port ||
    target.username.trim() !== (resolvedEndpoint.user?.trim() ?? '')
  )
}

export function isOpenSshConfigBackedTarget(
  target: Pick<SshTarget, 'source' | 'configHost' | 'host'>
): boolean {
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
