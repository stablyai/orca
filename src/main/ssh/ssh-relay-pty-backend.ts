import type { SshTerminalPersistenceBackend } from '../../shared/ssh-terminal-persistence'

export class RelayPtyBackendMismatchError extends Error {}

export function assertRelayPtyBackend(
  probeOutput: string,
  requested: SshTerminalPersistenceBackend
): void {
  const trimmed = probeOutput.trim()
  if (!trimmed.startsWith('ALIVE')) {
    return
  }
  const active = trimmed.split(':', 2)[1] === 'zmx' ? 'zmx' : 'relay'
  if (active !== requested) {
    throw new RelayPtyBackendMismatchError(
      `The active relay uses ${active} terminal persistence. Reset Relay to apply ${requested}.`
    )
  }
}

export function parseRemoteZmxPath(output: string): string {
  const path = output.trim()
  if (!path.startsWith('/') || path.includes('\n') || path.includes('\r')) {
    throw new Error(
      'zmx terminal persistence is enabled, but zmx was not found in the remote login PATH'
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
