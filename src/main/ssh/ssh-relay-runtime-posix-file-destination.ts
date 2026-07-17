import {
  openSshRelayRuntimeCommandFileDestination,
  SSH_RELAY_RUNTIME_COMMAND_FILE_DESTINATION_LIMITS,
  type SshRelayRuntimeCommandFileChannel
} from './ssh-relay-runtime-command-file-destination'
import type { SshRelayRuntimeSourceDestination } from './ssh-relay-runtime-source-stream'

export type SshRelayRuntimePosixFileChannel = SshRelayRuntimeCommandFileChannel

export type OpenSshRelayRuntimePosixFileDestinationOptions = Readonly<{
  remotePath: string
  mode: 0o644 | 0o755
  signal: AbortSignal
  openChannel: (command: string, signal: AbortSignal) => Promise<SshRelayRuntimePosixFileChannel>
}>

export const SSH_RELAY_RUNTIME_POSIX_FILE_DESTINATION_LIMITS =
  SSH_RELAY_RUNTIME_COMMAND_FILE_DESTINATION_LIMITS

function validateOptions(options: OpenSshRelayRuntimePosixFileDestinationOptions): void {
  if (
    !options ||
    typeof options.remotePath !== 'string' ||
    typeof options.openChannel !== 'function' ||
    !options.signal
  ) {
    throw new Error('SSH relay runtime POSIX file destination input is invalid')
  }
  const segments = options.remotePath.split('/')
  if (
    options.remotePath === '/' ||
    !options.remotePath.startsWith('/') ||
    options.remotePath.includes('\0') ||
    options.remotePath.includes('\n') ||
    options.remotePath.includes('\r') ||
    segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('SSH relay runtime POSIX file destination path is invalid')
  }
  if (options.mode !== 0o644 && options.mode !== 0o755) {
    throw new Error('SSH relay runtime POSIX file destination mode is invalid')
  }
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function buildCommand(remotePath: string, mode: 0o644 | 0o755): string {
  const quotedPath = quotePosixShellArgument(remotePath)
  const finalMode = mode.toString(8).padStart(4, '0')
  // Why: noclobber plus umask makes authenticated staging exclusive and non-readable until EOF.
  return `umask 077; set -C; cat > ${quotedPath} && chmod ${finalMode} ${quotedPath}`
}

export async function openSshRelayRuntimePosixFileDestination(
  options: OpenSshRelayRuntimePosixFileDestinationOptions
): Promise<SshRelayRuntimeSourceDestination> {
  validateOptions(options)
  return await openSshRelayRuntimeCommandFileDestination({
    command: buildCommand(options.remotePath, options.mode),
    fileKind: 'POSIX',
    signal: options.signal,
    openChannel: options.openChannel
  })
}
