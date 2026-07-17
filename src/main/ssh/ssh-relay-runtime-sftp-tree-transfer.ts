import { assertSafeRemotePathSegment, normalizeWindowsRemotePath } from './ssh-remote-platform'
import {
  openSshRelayRuntimeSftpFileDestination,
  type SshRelayRuntimeSftpFileOperations
} from './ssh-relay-runtime-sftp-file-destination'
import type { SshRelayRuntimeScannedSourceTree } from './ssh-relay-runtime-source-scan'
import {
  streamSshRelayRuntimeSourceTree,
  type SshRelayRuntimeSourceStreamOptions,
  type SshRelayRuntimeSourceStreamResult
} from './ssh-relay-runtime-source-stream'

type SftpCallback = (error?: Error) => void

export type SshRelayRuntimeSftpTreeOperations = SshRelayRuntimeSftpFileOperations &
  Readonly<{
    mkdir: (path: string, attributes: { mode: number }, callback: SftpCallback) => void
    rmdir: (path: string, callback: SftpCallback) => void
  }>

export type SshRelayRuntimeSftpTreeSession = Readonly<{
  operations: SshRelayRuntimeSftpTreeOperations
  // Why: the raw-session adapter must settle retained callbacks before resolving close.
  close: (reason?: unknown) => Promise<void>
}>

export type SshRelayRuntimeSftpTreeTransferOptions = Readonly<{
  tree: SshRelayRuntimeScannedSourceTree
  remoteStagingRoot: string
  enforcePosixMode: boolean
  signal: AbortSignal
  maximumConcurrency?: number
  openSession: (signal: AbortSignal) => Promise<SshRelayRuntimeSftpTreeSession>
  onProgress?: SshRelayRuntimeSourceStreamOptions['onProgress']
}>

export type SshRelayRuntimeSftpTreeTransferResult = Readonly<
  SshRelayRuntimeSourceStreamResult & { remoteStagingRoot: string }
>

const MAXIMUM_CONCURRENT_FILES = 4
const ABORTED_CALLBACK_BREAKER_MS = 250

function waitForSftpCallback(register: (callback: SftpCallback) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    register((error) => (error ? reject(error) : resolve()))
  })
}

function isNoSuchFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 2
}

function normalizeStagingRoot(tree: SshRelayRuntimeScannedSourceTree, value: string): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new Error('SSH relay runtime SFTP staging root is invalid')
  }
  const normalized = tree.os === 'win32' ? normalizeWindowsRemotePath(value) : value
  const trimmed = normalized.replace(/\/+$/u, '')
  if (
    trimmed === '' ||
    trimmed === '/' ||
    (tree.os !== 'win32' && !trimmed.startsWith('/')) ||
    (tree.os === 'win32' && !(/^[A-Za-z]:\//u.test(trimmed) || trimmed.startsWith('//')))
  ) {
    throw new Error('SSH relay runtime SFTP staging root is invalid')
  }
  return trimmed
}

function remoteManifestPath(
  tree: SshRelayRuntimeScannedSourceTree,
  remoteStagingRoot: string,
  manifestPath: string
): string {
  const pathFlavor = tree.os === 'win32' ? 'windows' : 'posix'
  const segments = manifestPath.split('/')
  for (const segment of segments) {
    assertSafeRemotePathSegment(segment, pathFlavor)
  }
  // Why: manifest paths are remote slash paths; client-native path.join would corrupt cross-OS use.
  return `${remoteStagingRoot}/${segments.join('/')}`
}

function validateOptions(options: SshRelayRuntimeSftpTreeTransferOptions): number {
  const concurrency = options.maximumConcurrency ?? 1
  if (
    !options.tree ||
    typeof options.openSession !== 'function' ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAXIMUM_CONCURRENT_FILES
  ) {
    throw new Error('SSH relay runtime SFTP tree transfer input is invalid')
  }
  if (options.enforcePosixMode !== (options.tree.os !== 'win32')) {
    throw new Error('SSH relay runtime SFTP tree mode policy is inconsistent')
  }
  return concurrency
}

function validateSession(session: SshRelayRuntimeSftpTreeSession): void {
  const operations = session?.operations
  for (const name of [
    'mkdir',
    'rmdir',
    'open',
    'write',
    'fchmod',
    'fstat',
    'close',
    'unlink'
  ] as const) {
    if (typeof operations?.[name] !== 'function') {
      throw new Error('SSH relay runtime SFTP session is incomplete')
    }
  }
  if (typeof session.close !== 'function') {
    throw new Error('SSH relay runtime SFTP session is incomplete')
  }
}

async function cleanupOwnedTree(
  operations: SshRelayRuntimeSftpTreeOperations,
  ownedFiles: ReadonlySet<string>,
  ownedDirectories: readonly string[]
): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const path of [...ownedFiles].toReversed()) {
    await waitForSftpCallback((callback) => operations.unlink(path, callback)).catch((error) => {
      if (!isNoSuchFile(error)) {
        failures.push(error)
      }
    })
  }
  for (const path of ownedDirectories.toReversed()) {
    await waitForSftpCallback((callback) => operations.rmdir(path, callback)).catch((error) => {
      if (!isNoSuchFile(error)) {
        failures.push(error)
      }
    })
  }
  return failures
}

function joinedFailure(primary: unknown, failures: readonly unknown[]): unknown {
  const unique = failures.filter(
    (failure, index) => failure !== primary && failures.indexOf(failure) === index
  )
  return unique.length === 0
    ? primary
    : new AggregateError(
        [primary, ...unique],
        'SSH relay runtime SFTP tree transfer cleanup failed'
      )
}

export async function transferSshRelayRuntimeTreeViaSftp(
  options: SshRelayRuntimeSftpTreeTransferOptions
): Promise<SshRelayRuntimeSftpTreeTransferResult> {
  const maximumConcurrency = validateOptions(options)
  const { tree, signal, openSession, enforcePosixMode, onProgress } = options
  const remoteStagingRoot = normalizeStagingRoot(tree, options.remoteStagingRoot)
  signal.throwIfAborted()
  const session = await openSession(signal)
  let closePromise: Promise<void> | undefined
  let abortedCallbackBreaker: ReturnType<typeof setTimeout> | undefined
  const closeSession = (reason?: unknown): Promise<void> => {
    closePromise ??= Promise.resolve().then(() => session.close(reason))
    return closePromise
  }
  const clearAbortedCallbackBreaker = (): void => {
    clearTimeout(abortedCallbackBreaker)
    abortedCallbackBreaker = undefined
  }
  const onAbort = (): void => {
    if (abortedCallbackBreaker || closePromise) {
      return
    }
    // Why: normal cancellation gets a cleanup opportunity, but a retained raw callback needs close.
    abortedCallbackBreaker = setTimeout(() => {
      abortedCallbackBreaker = undefined
      void closeSession(signal.reason).catch(() => {})
    }, ABORTED_CALLBACK_BREAKER_MS)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) {
    onAbort()
  }

  const ownedDirectories: string[] = []
  const ownedFiles = new Set<string>()
  try {
    validateSession(session)
    signal.throwIfAborted()
    await waitForSftpCallback((callback) =>
      session.operations.mkdir(remoteStagingRoot, { mode: 0o700 }, callback)
    )
    ownedDirectories.push(remoteStagingRoot)
    signal.throwIfAborted()

    const directories = [...tree.directories].sort(
      (left, right) =>
        left.path.split('/').length - right.path.split('/').length ||
        (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    )
    for (const directory of directories) {
      signal.throwIfAborted()
      const remotePath = remoteManifestPath(tree, remoteStagingRoot, directory.path)
      await waitForSftpCallback((callback) =>
        session.operations.mkdir(remotePath, { mode: directory.mode }, callback)
      )
      ownedDirectories.push(remotePath)
      signal.throwIfAborted()
    }

    const result = await streamSshRelayRuntimeSourceTree({
      tree,
      signal,
      maximumConcurrency,
      onProgress,
      openDestination: async (file, exactSignal) => {
        const remotePath = remoteManifestPath(tree, remoteStagingRoot, file.path)
        const trackedOperations: SshRelayRuntimeSftpFileOperations = {
          ...session.operations,
          open: (path, flags, attributes, callback) =>
            session.operations.open(path, flags, attributes, (error, handle) => {
              if (!error) {
                ownedFiles.add(path)
              }
              callback(error, handle)
            })
        }
        return openSshRelayRuntimeSftpFileDestination({
          operations: trackedOperations,
          remotePath,
          mode: file.mode,
          enforcePosixMode,
          signal: exactSignal
        })
      }
    })
    signal.throwIfAborted()
    await closeSession()
    signal.throwIfAborted()
    return Object.freeze({ remoteStagingRoot, ...result })
  } catch (error) {
    // The stream reached a settled callback boundary, so reverse cleanup can safely own shutdown.
    clearAbortedCallbackBreaker()
    const cleanupFailures =
      ownedDirectories.length === 0
        ? []
        : await cleanupOwnedTree(session.operations, ownedFiles, ownedDirectories)
    await closeSession(error).catch((closeError) => cleanupFailures.push(closeError))
    throw joinedFailure(error, cleanupFailures)
  } finally {
    clearAbortedCallbackBreaker()
    signal.removeEventListener('abort', onAbort)
  }
}

export const SSH_RELAY_RUNTIME_SFTP_TREE_TRANSFER_LIMITS = Object.freeze({
  maximumConcurrentFiles: MAXIMUM_CONCURRENT_FILES,
  abortedCallbackBreakerMs: ABORTED_CALLBACK_BREAKER_MS
})
