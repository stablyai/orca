import { assertSafeRemotePathSegment, normalizeWindowsRemotePath } from './ssh-remote-platform'
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
import { openSshRelayRuntimeWindowsFileDestination } from './ssh-relay-runtime-windows-file-destination'
import {
  runSshRelayRuntimeWindowsStagingControl,
  type RunSshRelayRuntimeWindowsStagingControlOptions
} from './ssh-relay-runtime-windows-staging-control'

export type SshRelayRuntimeWindowsTreeTransferOptions = Readonly<{
  tree: SshRelayRuntimeScannedSourceTree
  connection: SshRelayRuntimeSystemSshConnection
  remoteStagingRoot: string
  signal: AbortSignal
  maximumConcurrency?: number
  onProgress?: SshRelayRuntimeSourceStreamOptions['onProgress']
}>

export type SshRelayRuntimeWindowsTreeTransferResult = Readonly<
  SshRelayRuntimeSourceStreamResult & { remoteStagingRoot: string }
>

const MAXIMUM_CONCURRENT_FILES = 4
const CLEANUP_TIMEOUT_MS = 5_000

type OpenChannel = RunSshRelayRuntimeWindowsStagingControlOptions['openChannel']

function normalizeStagingRoot(value: string): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new Error('SSH relay runtime Windows staging root is invalid')
  }
  const normalized = normalizeWindowsRemotePath(value)
  const driveRooted = /^[A-Za-z]:\//u.test(normalized)
  const uncRooted = /^\/\/[^/]+\/[^/]+\//u.test(normalized)
  if ((!driveRooted && !uncRooted) || normalized.endsWith('/')) {
    throw new Error('SSH relay runtime Windows staging root is invalid')
  }
  const segments = driveRooted ? normalized.slice(3).split('/') : normalized.slice(2).split('/')
  try {
    for (const segment of segments) {
      assertSafeRemotePathSegment(segment, 'windows')
    }
  } catch {
    throw new Error('SSH relay runtime Windows staging root is invalid')
  }
  return normalized
}

function validateOptions(options: SshRelayRuntimeWindowsTreeTransferOptions): number {
  const concurrency = options?.maximumConcurrency ?? 1
  if (
    !options?.tree ||
    !options.connection ||
    typeof options.connection.usesSystemSshTransport !== 'function' ||
    typeof options.connection.exec !== 'function' ||
    !options.signal ||
    typeof options.signal.throwIfAborted !== 'function' ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAXIMUM_CONCURRENT_FILES
  ) {
    throw new Error('SSH relay runtime Windows tree transfer input or concurrency is invalid')
  }
  if (options.tree.os !== 'win32') {
    throw new Error('SSH relay runtime Windows tree transfer requires a Windows tree')
  }
  if (!options.connection.usesSystemSshTransport()) {
    throw new Error('SSH relay runtime Windows tree transfer requires system SSH transport')
  }
  return concurrency
}

function remoteManifestPath(remoteStagingRoot: string, manifestPath: string): string {
  const segments = manifestPath.split('/')
  for (const segment of segments) {
    assertSafeRemotePathSegment(segment, 'windows')
  }
  // Why: manifest paths are remote slash paths; client-native path utilities would corrupt them.
  return `${remoteStagingRoot}/${segments.join('/')}`
}

function joinedFailure(primary: unknown, cleanupFailure: unknown | undefined): unknown {
  return cleanupFailure === undefined
    ? primary
    : new AggregateError(
        [primary, cleanupFailure],
        'SSH relay runtime Windows tree transfer cleanup failed'
      )
}

async function cleanupOwnedRoot(
  remoteStagingRoot: string,
  openChannel: OpenChannel
): Promise<void> {
  const controller = new AbortController()
  // Why: caller cancellation initiates cleanup; a separate bounded signal lets cleanup still run.
  const timeout = setTimeout(
    () => controller.abort(new Error('SSH relay runtime Windows tree cleanup timed out')),
    CLEANUP_TIMEOUT_MS
  )
  try {
    await runSshRelayRuntimeWindowsStagingControl({
      operation: 'remove-root',
      remoteRoot: remoteStagingRoot,
      signal: controller.signal,
      openChannel
    })
  } finally {
    clearTimeout(timeout)
  }
}

export async function transferSshRelayRuntimeTreeViaWindowsSystemSsh(
  options: SshRelayRuntimeWindowsTreeTransferOptions
): Promise<SshRelayRuntimeWindowsTreeTransferResult> {
  const maximumConcurrency = validateOptions(options)
  const { tree, connection, signal, onProgress } = options
  const remoteStagingRoot = normalizeStagingRoot(options.remoteStagingRoot)
  const openChannel: OpenChannel = (command, exactSignal) =>
    openSshRelayRuntimeSystemSshFileChannel(connection, command, exactSignal, 'powershell')
  const runControl = (
    control: Omit<RunSshRelayRuntimeWindowsStagingControlOptions, 'signal' | 'openChannel'>
  ): Promise<void> => runSshRelayRuntimeWindowsStagingControl({ ...control, signal, openChannel })
  signal.throwIfAborted()
  let rootOwned = false

  try {
    await runControl({ operation: 'create-root', remoteRoot: remoteStagingRoot })
    rootOwned = true
    signal.throwIfAborted()

    const directories = [...tree.directories].sort(
      (left, right) =>
        left.path.split('/').length - right.path.split('/').length ||
        (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    )
    for (const directory of directories) {
      signal.throwIfAborted()
      await runControl({
        operation: 'create-directory',
        remoteRoot: remoteStagingRoot,
        remotePath: remoteManifestPath(remoteStagingRoot, directory.path)
      })
      signal.throwIfAborted()
    }

    const result = await streamSshRelayRuntimeSourceTree({
      tree,
      signal,
      maximumConcurrency,
      onProgress,
      openDestination: (file, exactSignal) =>
        openSshRelayRuntimeWindowsFileDestination({
          remotePath: remoteManifestPath(remoteStagingRoot, file.path),
          expectedSize: file.size,
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

export const SSH_RELAY_RUNTIME_WINDOWS_TREE_TRANSFER_LIMITS = Object.freeze({
  maximumConcurrentFiles: MAXIMUM_CONCURRENT_FILES,
  cleanupTimeoutMs: CLEANUP_TIMEOUT_MS
})
