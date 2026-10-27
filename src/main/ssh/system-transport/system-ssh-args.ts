import type { SshTarget } from '../../../shared/ssh-types'
import { getControlSocketPath, type SystemSshResolvedConfig } from '../ssh-control-socket'

export type SystemSshBuildArgsOptions = {
  configFile?: string
  resolvedConfig?: SystemSshResolvedConfig | null
  disableControlMaster?: boolean
  suppressOrcaControlMaster?: boolean
  gssapiOnly?: boolean
  nonInteractive?: boolean
  /** Keeps OpenSSH's channel-open failures on stderr even under a quieter configured LogLevel. */
  logChannelFailures?: boolean
  /** Only proven absence of a matching Host/Match block permits stored endpoint overrides; unknown keeps the alias authoritative. */
  aliasClaimedByConfig?: boolean
  /** Dial Orca's held `ssh -L` forward instead of the target's proxy. See `system-ssh-loopback-route`. */
  loopbackRoute?: SystemSshLoopbackRouteArgs
  /** Server-alive probes for a long-lived unmultiplexed process, which no ControlMaster watches. */
  keepAlive?: boolean
}

export type SystemSshLoopbackRouteArgs = {
  localPort: number
  hostKeyAlias: string
}

export function buildSshArgs(target: SshTarget, options?: SystemSshBuildArgsOptions): string[] {
  const args: string[] = []

  if (options?.configFile) {
    args.push('-F', options.configFile)
  }
  args.push('-o', options?.gssapiOnly || options?.nonInteractive ? 'BatchMode=yes' : 'BatchMode=no')
  if (options?.logChannelFailures) {
    // Why INFO: OpenSSH logs a refused forward channel at that level, below ERROR/QUIET.
    args.push('-o', 'LogLevel=INFO')
  }
  if (options?.gssapiOnly) {
    // Why: the probe must neither authenticate with a key nor open an OpenSSH
    // credential prompt; failure belongs to Orca's existing ssh2 prompt path.
    args.push('-o', 'GSSAPIAuthentication=yes')
    args.push('-o', 'PreferredAuthentications=gssapi-with-mic')
  }
  args.push('-T')

  // Reuse one SSH connection across execs to avoid a fresh handshake per command.
  const controlPath = getOrcaControlSocketPath(target, options)
  const forceDisableControlMaster =
    options?.disableControlMaster === true ||
    target.systemSshConnectionReuse === false ||
    (options?.gssapiOnly === true && controlPath === null)
  if (forceDisableControlMaster) {
    // Mux forwards outlive their client; also honor the target opt-out over broad Host * multiplexing.
    args.push('-S', 'none')
  } else if (controlPath) {
    args.push('-o', 'ControlMaster=auto')
    args.push('-o', `ControlPath=${controlPath}`)
    // Retain the idle master for reconnects without keeping a client process open.
    args.push('-o', 'ControlPersist=300')
  }
  if (options?.keepAlive || (!forceDisableControlMaster && controlPath)) {
    args.push('-o', 'ServerAliveInterval=15')
    args.push('-o', 'ServerAliveCountMax=3')
  }

  appendSshTargetDestinationArgs(args, target, options)
  return args
}

/** Saved-target routing and login args, separate from Orca transport options. */
export function appendSshTargetDestinationArgs(
  args: string[],
  target: SshTarget,
  options?: Pick<SystemSshBuildArgsOptions, 'aliasClaimedByConfig' | 'gssapiOnly' | 'loopbackRoute'>
): void {
  const useConfigHost = shouldUseOpenSshConfigHost(target)
  const loopbackRoute = options?.loopbackRoute
  if (loopbackRoute) {
    // OpenSSH takes the first option value: override routing while retaining alias identity and known_hosts settings.
    args.push('-o', 'HostName=127.0.0.1')
    args.push('-o', `Port=${loopbackRoute.localPort}`)
    args.push('-o', 'ProxyCommand=none')
    args.push('-o', 'ProxyJump=none')
    args.push('-o', `HostKeyAlias=${loopbackRoute.hostKeyAlias}`)
  }

  // An unclaimed alias may inherit wildcard routing; restore its saved endpoint only on proven absence of a claiming block.
  if (useConfigHost && options?.aliasClaimedByConfig === false) {
    appendUnclaimedAliasEndpoint(args, target)
  }

  if (!useConfigHost && !loopbackRoute && target.port !== 22) {
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

  if (!useConfigHost && target.gssapiAuthentication && !options?.gssapiOnly) {
    // Why: manual targets bypass ssh_config, so Kerberos auth must be
    // requested explicitly; config-backed hosts inherit it from their entry.
    args.push('-o', 'GSSAPIAuthentication=yes')
  }

  // Why: `-J` after `ProxyJump=none` is a fatal duplicate in OpenSSH, so the route skips both proxies.
  if (!useConfigHost && !loopbackRoute && target.jumpHost) {
    args.push('-J', target.jumpHost)
  }

  if (!useConfigHost && !loopbackRoute && target.proxyCommand) {
    args.push('-o', `ProxyCommand=${target.proxyCommand}`)
  }

  const host = target.configHost || target.host
  // Keep alias User authoritative, including fresh wildcard, Include and Match results.
  const userHost = useConfigHost ? host : target.username ? `${target.username}@${host}` : host
  args.push('--', userHost)
}

/** Forwards must own their listener and refusal stderr: a mux client exits while its master retains both. If standalone auth cannot repeat, managed tunnels use the master's exec bridge. */
export function buildForwardProcessSshArgs(
  target: SshTarget,
  options?: SystemSshBuildArgsOptions
): string[] {
  // Why no loopbackRoute: forwards outlive commands, and the route's own forward must take the real proxy.
  return buildSshArgs(target, {
    ...options,
    loopbackRoute: undefined,
    suppressOrcaControlMaster: true,
    disableControlMaster: true
  })
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
  if (options?.aliasClaimedByConfig === false) {
    buildArgsOptions.aliasClaimedByConfig = false
  }
  if (options?.loopbackRoute !== undefined) {
    buildArgsOptions.loopbackRoute = options.loopbackRoute
  }
  return Object.keys(buildArgsOptions).length === 0 ? undefined : buildArgsOptions
}

function shouldDisableOrcaControlMaster(
  target: SshTarget,
  options?: SystemSshBuildArgsOptions
): boolean {
  // Unresolved aliases may route through mutable ssh_config; never pool them on a guessed endpoint.
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
  // ControlPersist/ControlPath reuse existing masters; Orca also needs ControlMaster enabled to create one.
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

/** Restore only Hostname/Port/User; matching still uses the original alias, preserving wildcard proxies and identities while %h expands to the saved host. */
function appendUnclaimedAliasEndpoint(args: string[], target: SshTarget): void {
  const alias = target.configHost
  const storedHost = target.host.trim()
  if (storedHost && alias && storedHost !== alias) {
    args.push('-o', `Hostname=${storedHost}`)
  }
  if (target.port && target.port !== 22) {
    args.push('-p', String(target.port))
  }
  if (target.username) {
    args.push('-l', target.username)
  }
}

function shouldUseOpenSshConfigHost(target: SshTarget): boolean {
  if (!target.configHost) {
    return false
  }
  return isOpenSshConfigBackedTarget(target)
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
  // Legacy aliases differ from host; manual configHost=host still needs explicit port/identity args.
  return Boolean(target.configHost && target.configHost !== target.host)
}
