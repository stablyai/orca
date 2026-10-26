import type {
  Client as SshClient,
  ClientChannel,
  PseudoTtyOptions,
  SFTPWrapper,
  ShellOptions
} from 'ssh2'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SystemSshBuildArgsOptions } from '../system-transport/system-ssh-args'
import { spawnSystemSshCommand } from '../system-transport/system-ssh-command'
import { wrapRemoteCommandForPosixShell } from '../ssh-posix-command-wrapper'
import { openSshSessionChannelWithRetry, waitForSshChannelOpen } from '../ssh-channel-open'
import { tagSftpHandshakeCorruption } from '../sftp-handshake-corruption'
import { trackSshConnectionChannelLifetime } from './ssh-connection-channel-lifetime'
import { createSshOperationAbortError, type SshExecOptions } from './ssh-exec-options'

/** What channel opening reads from its connection; getters so each read sees the live transport. */
export type SshSessionChannelHost = {
  target: SshTarget
  client: () => SshClient | null
  usesSystemSshTransport: () => boolean
  isDisposed: () => boolean
  isConnected: () => boolean
  systemSshBuildArgsOptions: () => SystemSshBuildArgsOptions
  /** Owned by the connection so reconnect and disconnect can close every live system command. */
  systemCommandChannels: Set<ClientChannel>
}

/** Work after disconnect() fails with the operation abort error. */
function assertNotDisposed(host: SshSessionChannelHost): void {
  if (host.isDisposed()) {
    throw createSshOperationAbortError()
  }
}

/** Names the connection and channel kind when a tracked channel's error has no other handler. */
function reportUnhandledChannelError(
  host: SshSessionChannelHost,
  kind: string
): (error: Error) => void {
  return (error) =>
    console.warn(`[ssh] Unhandled ${kind} channel error for ${host.target.label}: ${error.message}`)
}

export async function openSshExecChannel(
  host: SshSessionChannelHost,
  cmd: string,
  options?: SshExecOptions
): Promise<ClientChannel> {
  assertNotDisposed(host)
  if (options?.signal?.aborted) {
    throw createSshOperationAbortError()
  }
  if (host.usesSystemSshTransport()) {
    if (host.isDisposed() || !host.isConnected()) {
      throw new Error('Not connected')
    }
    return spawnTrackedSystemSshChannel(host, cmd, options)
  }
  // Keep retries on the original client; reconnect replacements belong to new calls.
  const client = host.client()
  if (!client) {
    throw new Error('Not connected')
  }
  const remoteCommand =
    options?.wrapCommand === false
      ? cmd
      : wrapRemoteCommandForPosixShell(cmd, { compress: options?.compressCommand === true })
  return openSshSessionChannelWithRetry(() => {
    assertNotDisposed(host)
    return waitForSshChannelOpen(
      'SSH exec channel timed out',
      (callback) => client.exec(remoteCommand, callback),
      (channel) => channel.close(),
      options?.signal,
      true,
      reportUnhandledChannelError(host, 'exec')
    )
  }, options?.signal)
}

/** Interactive login shell over a session channel with pty-req; ssh2 transport only. */
export async function openSshShellChannel(
  host: SshSessionChannelHost,
  pty: PseudoTtyOptions,
  options: ShellOptions
): Promise<ClientChannel> {
  assertNotDisposed(host)
  if (host.usesSystemSshTransport()) {
    throw new Error('Interactive SSH shells are not available when using system SSH transport')
  }
  const client = host.client()
  if (!client) {
    throw new Error('Not connected')
  }
  return openSshSessionChannelWithRetry(() => {
    assertNotDisposed(host)
    return waitForSshChannelOpen(
      'SSH shell channel timed out',
      (callback) => client.shell(pty, options, callback),
      (channel) => channel.close(),
      undefined,
      false,
      reportUnhandledChannelError(host, 'shell')
    )
  })
}

export async function openSshSftpChannel(
  host: SshSessionChannelHost,
  options?: AbortSignal | { signal?: AbortSignal }
): Promise<SFTPWrapper> {
  assertNotDisposed(host)
  // Relay transfers pass signals directly; filesystem factories wrap them in options.
  const signal = options && 'aborted' in options ? options : options?.signal
  if (signal?.aborted) {
    throw createSshOperationAbortError()
  }
  if (host.usesSystemSshTransport()) {
    throw new Error('SFTP is not available when using system SSH transport')
  }
  const client = host.client()
  if (!client) {
    throw new Error('Not connected')
  }
  return openSshSessionChannelWithRetry(() => {
    assertNotDisposed(host)
    return waitForSshChannelOpen(
      'SSH SFTP channel timed out',
      (callback) =>
        client.sftp((error, sftp) => callback(error && tagSftpHandshakeCorruption(error), sftp)),
      (sftp) => sftp.end(),
      signal,
      false,
      reportUnhandledChannelError(host, 'sftp')
    )
  }, signal)
}

export function spawnTrackedSystemSshChannel(
  host: SshSessionChannelHost,
  command: string,
  options?: SshExecOptions
): ClientChannel {
  if (options?.signal?.aborted) {
    throw createSshOperationAbortError()
  }
  const buildArgsOptions = host.systemSshBuildArgsOptions()
  const commandOptions =
    options === undefined && Object.keys(buildArgsOptions).length === 0
      ? undefined
      : { ...options, ...buildArgsOptions }
  assertNotDisposed(host)
  const channel =
    commandOptions === undefined
      ? spawnSystemSshCommand(host.target, command)
      : spawnSystemSshCommand(host.target, command, commandOptions)
  trackSshConnectionChannelLifetime(channel, reportUnhandledChannelError(host, 'command'))
  host.systemCommandChannels.add(channel)
  const onAbort = (): void => {
    channel.close()
  }
  const cleanup = (): void => {
    options?.signal?.removeEventListener('abort', onAbort)
    host.systemCommandChannels.delete(channel)
  }
  options?.signal?.addEventListener('abort', onAbort, { once: true })
  channel.once('close', cleanup)
  channel.once('error', cleanup)
  return channel
}
