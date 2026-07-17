import { assertSafeRemotePathSegment } from './ssh-remote-platform'
import {
  runSshRelayRuntimePosixControlCommand,
  type RunSshRelayRuntimePosixControlCommandOptions
} from './ssh-relay-runtime-posix-control-command'
import { openSshRelayRuntimePosixFileDestination } from './ssh-relay-runtime-posix-file-destination'
import type { SshRelayRuntimeScannedSourceTree } from './ssh-relay-runtime-source-scan'
import {
  streamSshRelayRuntimeSourceTree,
  type SshRelayRuntimeSourceStreamOptions,
  type SshRelayRuntimeSourceStreamResult
} from './ssh-relay-runtime-source-stream'
import {
  openSshRelayRuntimeSystemSshFileChannel,
  type SshRelayRuntimeSystemSshConnection
} from './ssh-relay-runtime-system-ssh-file-channel'

export type SshRelayRuntimePosixTreeTransferOptions = Readonly<{
  tree: SshRelayRuntimeScannedSourceTree
  connection: SshRelayRuntimeSystemSshConnection
  remoteStagingRoot: string
  signal: AbortSignal
  maximumConcurrency?: number
  onProgress?: SshRelayRuntimeSourceStreamOptions['onProgress']
}>

export type SshRelayRuntimePosixTreeTransferResult = Readonly<
  SshRelayRuntimeSourceStreamResult & { remoteStagingRoot: string }
>

const MAXIMUM_CONCURRENT_FILES = 4
const CLEANUP_TIMEOUT_MS = 5_000

type OpenChannel = RunSshRelayRuntimePosixControlCommandOptions['openChannel']

function normalizeStagingRoot(value: string): string {
  if (typeof value !== 'string') {
    throw new Error('SSH relay runtime POSIX staging root is invalid')
  }
  const segments = value.split('/')
  if (
    value === '/' ||
    !value.startsWith('/') ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n') ||
    segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('SSH relay runtime POSIX staging root is invalid')
  }
  return value
}

function validateOptions(options: SshRelayRuntimePosixTreeTransferOptions): number {
  const concurrency = options?.maximumConcurrency ?? 1
  if (
    !options?.tree ||
    !options.connection ||
    typeof options.connection.usesSystemSshTransport !== 'function' ||
    typeof options.connection.exec !== 'function' ||
    !options.signal ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAXIMUM_CONCURRENT_FILES
  ) {
    throw new Error('SSH relay runtime POSIX tree transfer input or concurrency is invalid')
  }
  if (options.tree.os === 'win32') {
    throw new Error('SSH relay runtime POSIX tree transfer requires a POSIX tree')
  }
  if (!options.connection.usesSystemSshTransport()) {
    throw new Error('SSH relay runtime POSIX tree transfer requires system SSH transport')
  }
  return concurrency
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function remoteManifestPath(remoteStagingRoot: string, manifestPath: string): string {
  const segments = manifestPath.split('/')
  for (const segment of segments) {
    assertSafeRemotePathSegment(segment, 'posix')
  }
  // Why: manifest paths are remote slash paths; client-native path utilities would corrupt them.
  return `${remoteStagingRoot}/${segments.join('/')}`
}

function rootCommand(remoteStagingRoot: string): string {
  return `umask 077; mkdir ${quotePosixShellArgument(remoteStagingRoot)}`
}

function directoryCommand(remotePath: string): string {
  const quoted = quotePosixShellArgument(remotePath)
  return `umask 077; mkdir ${quoted} && chmod 0755 ${quoted}`
}

function cleanupCommand(remoteStagingRoot: string): string {
  return `rm -rf ${quotePosixShellArgument(remoteStagingRoot)}`
}

function joinedFailure(primary: unknown, cleanupFailure: unknown | undefined): unknown {
  return cleanupFailure === undefined
    ? primary
    : new AggregateError(
        [primary, cleanupFailure],
        'SSH relay runtime POSIX tree transfer cleanup failed'
      )
}

async function cleanupOwnedRoot(
  remoteStagingRoot: string,
  openChannel: OpenChannel
): Promise<void> {
  const controller = new AbortController()
  // Why: caller cancellation initiates cleanup; a separate bounded signal lets cleanup still run.
  const timeout = setTimeout(
    () => controller.abort(new Error('SSH relay runtime POSIX tree cleanup timed out')),
    CLEANUP_TIMEOUT_MS
  )
  try {
    await runSshRelayRuntimePosixControlCommand({
      command: cleanupCommand(remoteStagingRoot),
      signal: controller.signal,
      openChannel
    })
  } finally {
    clearTimeout(timeout)
  }
}

export async function transferSshRelayRuntimeTreeViaPosixSystemSsh(
  options: SshRelayRuntimePosixTreeTransferOptions
): Promise<SshRelayRuntimePosixTreeTransferResult> {
  const maximumConcurrency = validateOptions(options)
  const { tree, connection, signal, onProgress } = options
  const remoteStagingRoot = normalizeStagingRoot(options.remoteStagingRoot)
  const openChannel: OpenChannel = (command, exactSignal) =>
    openSshRelayRuntimeSystemSshFileChannel(connection, command, exactSignal, 'posix')
  const runControl = (command: string): Promise<void> =>
    runSshRelayRuntimePosixControlCommand({ command, signal, openChannel })
  signal.throwIfAborted()
  let rootOwned = false

  try {
    await runControl(rootCommand(remoteStagingRoot))
    rootOwned = true
    signal.throwIfAborted()

    const directories = [...tree.directories].sort(
      (left, right) =>
        left.path.split('/').length - right.path.split('/').length ||
        (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    )
    for (const directory of directories) {
      signal.throwIfAborted()
      await runControl(directoryCommand(remoteManifestPath(remoteStagingRoot, directory.path)))
      signal.throwIfAborted()
    }

    const result = await streamSshRelayRuntimeSourceTree({
      tree,
      signal,
      maximumConcurrency,
      onProgress,
      openDestination: (file, exactSignal) =>
        openSshRelayRuntimePosixFileDestination({
          remotePath: remoteManifestPath(remoteStagingRoot, file.path),
          mode: file.mode,
          signal: exactSignal,
          openChannel
        })
    })
    signal.throwIfAborted()
    return Object.freeze({ remoteStagingRoot, ...result })
  } catch (error) {
    let cleanupFailure: unknown
    if (rootOwned) {
      try {
        await cleanupOwnedRoot(remoteStagingRoot, openChannel)
      } catch (cleanupError) {
        cleanupFailure = cleanupError
      }
    }
    throw joinedFailure(error, cleanupFailure)
  }
}

export const SSH_RELAY_RUNTIME_POSIX_TREE_TRANSFER_LIMITS = Object.freeze({
  maximumConcurrentFiles: MAXIMUM_CONCURRENT_FILES,
  cleanupTimeoutMs: CLEANUP_TIMEOUT_MS
})
