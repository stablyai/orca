import type { SshTerminalPersistenceBackend } from '../../shared/ssh-terminal-persistence'

export class RelayPtyBackendMismatchError extends Error {
  constructor(
    message: string,
    readonly activeBackend: SshTerminalPersistenceBackend = 'relay'
  ) {
    super(message)
  }
}

export function assertRelayPtyBackend(
  probeOutput: string,
  requested: SshTerminalPersistenceBackend
): void {
  const trimmed = probeOutput.trim()
  if (!trimmed.startsWith('ALIVE') && !trimmed.startsWith('DEAD')) {
    return
  }
  const active = trimmed.split(':', 2)[1] === 'zmx' ? 'zmx' : 'relay'
  if (trimmed.startsWith('ALIVE')) {
    if (active !== requested) {
      throw new RelayPtyBackendMismatchError(
        `The active relay uses ${active} terminal persistence. Reset Relay to apply ${requested}.`,
        active
      )
    }
    return
  }
  // Why: a dead relay still leaves durable zmx sessions running. Launching a
  // relay-backed relay over them would expire their leases while the sessions
  // live on with no reachable kill path except a reset the user never chose.
  if (active === 'zmx' && requested === 'relay') {
    throw new RelayPtyBackendMismatchError(
      'This host has durable zmx terminals from a previous session. Enable "Use zmx for durable terminals" to reattach them, or Reset Relay to end them.',
      active
    )
  }
}

export function parseRemoteZmxPath(output: string): string {
  const path = output.trim()
  // Why: login-shell probes can emit dotfile noise; only an absolute path whose
  // final component is the zmx binary may become the relay's --zmx-path.
  if (
    !path.startsWith('/') ||
    path.includes('\n') ||
    path.includes('\r') ||
    path.split('/').at(-1) !== 'zmx'
  ) {
    // Why: deterministic until the user installs zmx or disables the setting;
    // terminal classification skips the relay-lost backoff and releases fences.
    throw new RelayPtyBackendMismatchError(
      'zmx terminal persistence is enabled, but zmx was not found in the remote login PATH',
      'zmx'
    )
  }
  return path
}

export function relayPtyBackendLaunchArgs(
  backend: SshTerminalPersistenceBackend,
  zmxPath: string | undefined,
  escape: (value: string) => string
): string {
  return backend === 'zmx' && zmxPath ? ` --pty-backend zmx --zmx-path ${escape(zmxPath)}` : ''
}
