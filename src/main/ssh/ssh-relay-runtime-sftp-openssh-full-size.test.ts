import { createHash } from 'node:crypto'
import { lstat, open, opendir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import type { SshTarget } from '../../shared/ssh-types'
import { SshConnection } from './ssh-connection'
import { transferSshRelayRuntimeTreeOverSftpConnection } from './ssh-relay-runtime-sftp-connection-transfer'
import {
  scanSshRelayRuntimeSourceTree,
  type SshRelayRuntimeScannedSourceTree
} from './ssh-relay-runtime-source-scan'
import type { SshRelayRuntimeSourceTree } from './ssh-relay-runtime-source-tree'
import { SSH_RELAY_RUNTIME_SOURCE_STREAM_LIMITS } from './ssh-relay-runtime-source-stream'

type MeasurementIdentity = Pick<
  SshRelayRuntimeSourceTree,
  'tupleId' | 'contentId' | 'os' | 'architecture'
> & {
  entries: (
    | { path: string; type: 'directory'; mode: 0o755 }
    | {
        path: string
        type: 'file'
        role: SshRelayRuntimeSourceTree['files'][number]['role']
        size: number
        mode: 0o644 | 0o755
        sha256: SshRelayRuntimeSourceTree['files'][number]['sha256']
      }
  )[]
  archive: { expandedSize: number; fileCount: number }
}

type Measurement<T> = {
  result: T
  elapsedMs: number
  baselineRss: number
  peakRss: number
  incrementalRssBytes: number
}

const host = process.env.ORCA_SSH_RELAY_LIVE_SFTP_HOST
const user = process.env.ORCA_SSH_RELAY_LIVE_SFTP_USER
const identityFile = process.env.ORCA_SSH_RELAY_LIVE_SFTP_IDENTITY
const remoteRoot = process.env.ORCA_SSH_RELAY_LIVE_SFTP_REMOTE_ROOT
const runtimeRoot = process.env.ORCA_SSH_RELAY_FULL_SIZE_RUNTIME_ROOT
const identityPath = process.env.ORCA_SSH_RELAY_FULL_SIZE_IDENTITY
const port = Number.parseInt(process.env.ORCA_SSH_RELAY_LIVE_SFTP_PORT ?? '', 10)
const hasLiveInput = Boolean(
  host &&
  user &&
  identityFile &&
  remoteRoot &&
  runtimeRoot &&
  identityPath &&
  Number.isInteger(port)
)

function parseIdentity(value: unknown): MeasurementIdentity {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('entries' in value) ||
    !Array.isArray(value.entries) ||
    !('archive' in value) ||
    typeof value.archive !== 'object' ||
    value.archive === null
  ) {
    throw new Error('Live SFTP measurement identity is incomplete')
  }
  return value as MeasurementIdentity
}

function sourceTree(identity: MeasurementIdentity): SshRelayRuntimeSourceTree {
  const directories = identity.entries
    .filter((entry) => entry.type === 'directory')
    .map((entry) => ({
      ...entry,
      localPath: join(runtimeRoot as string, ...entry.path.split('/'))
    }))
  const files = identity.entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => ({
      ...entry,
      localPath: join(runtimeRoot as string, ...entry.path.split('/'))
    }))
  return Object.freeze({
    tupleId: identity.tupleId,
    contentId: identity.contentId,
    releaseTag: 'measurement-only',
    os: identity.os,
    architecture: identity.architecture,
    runtimeRoot: runtimeRoot as string,
    directories,
    files,
    fileCount: identity.archive.fileCount,
    expandedBytes: identity.archive.expandedSize,
    assertLeaseOwned: async () => {}
  })
}

async function measure<T>(operation: () => Promise<T>): Promise<Measurement<T>> {
  const baselineRss = process.memoryUsage().rss
  let peakRss = baselineRss
  const sample = (): void => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }
  const sampler = setInterval(sample, 1)
  const startedAt = performance.now()
  try {
    const result = await operation()
    sample()
    return {
      result,
      elapsedMs: performance.now() - startedAt,
      baselineRss,
      peakRss,
      incrementalRssBytes: Math.max(0, peakRss - baselineRss)
    }
  } finally {
    clearInterval(sampler)
  }
}

async function hashFile(path: string): Promise<string> {
  const handle = await open(path, 'r')
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) {
        break
      }
      digest.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
  return `sha256:${digest.digest('hex')}`
}

async function collectRemotePaths(root: string): Promise<string[]> {
  const paths: string[] = []
  const pending = [{ localPath: root, relativePath: '' }]
  while (pending.length > 0) {
    const current = pending.pop()!
    const directory = await opendir(current.localPath)
    for await (const entry of directory) {
      const relativePath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name
      paths.push(relativePath)
      if (entry.isDirectory()) {
        pending.push({ localPath: join(current.localPath, entry.name), relativePath })
      }
    }
  }
  return paths.sort()
}

async function validateTransferredTree(
  tree: SshRelayRuntimeScannedSourceTree,
  stage: string
): Promise<void> {
  const expectedPaths = [...tree.directories, ...tree.files].map((entry) => entry.path).sort()
  // Why: the loopback runner can inspect sshd's filesystem without adding another proof channel.
  expect(await collectRemotePaths(stage)).toEqual(expectedPaths)
  for (const directory of tree.directories) {
    const metadata = await lstat(join(stage, ...directory.path.split('/')))
    expect(metadata.isDirectory()).toBe(true)
    expect(metadata.mode & 0o777).toBe(directory.mode)
  }
  for (const file of tree.files) {
    const path = join(stage, ...file.path.split('/'))
    const metadata = await lstat(path)
    expect(metadata.isFile()).toBe(true)
    expect(metadata.size).toBe(file.size)
    expect(metadata.mode & 0o777).toBe(file.mode)
    expect(await hashFile(path)).toBe(file.sha256)
  }
}

function stagePath(name: string, identity: MeasurementIdentity): string {
  return join(remoteRoot as string, `${name}-${identity.contentId.slice('sha256:'.length, 23)}`)
}

async function transfer(
  connection: SshConnection,
  tree: SshRelayRuntimeScannedSourceTree,
  stage: string,
  maximumConcurrency: number,
  signal = new AbortController().signal,
  onProgress?: (bytes: number) => void
) {
  return transferSshRelayRuntimeTreeOverSftpConnection({
    connection,
    tree,
    remoteStagingRoot: stage,
    enforcePosixMode: true,
    maximumConcurrency,
    signal,
    onProgress: ({ bytesTransferred }) => onProgress?.(bytesTransferred)
  })
}

describe.skipIf(!hasLiveInput)('SSH relay full-size transfer through live OpenSSH SFTP', () => {
  it(
    'preserves exact bytes and modes with bounded serial, concurrent, and cancellation behavior',
    { timeout: 20 * 60_000 },
    async () => {
      const identity = parseIdentity(JSON.parse(await readFile(identityPath as string, 'utf8')))
      expect(identity.os).toBe('linux')
      const tree = await scanSshRelayRuntimeSourceTree(
        sourceTree(identity),
        new AbortController().signal
      )
      const target: SshTarget = {
        id: 'live-sftp-measurement',
        label: 'live-sftp-measurement',
        host: host as string,
        port,
        username: user as string,
        identityFile: identityFile as string,
        source: 'manual'
      }
      const connection = new SshConnection(target, { onStateChange: () => {} })
      const serialStage = stagePath('serial', identity)
      const concurrentStage = stagePath('concurrent', identity)
      const cancelledStage = stagePath('cancelled', identity)
      await Promise.all(
        [serialStage, concurrentStage, cancelledStage].map((stage) =>
          rm(stage, { recursive: true, force: true })
        )
      )
      try {
        await connection.connect()
        const serial = await measure(() => transfer(connection, tree, serialStage, 1))
        await validateTransferredTree(tree, serialStage)
        const concurrent = await measure(() => transfer(connection, tree, concurrentStage, 4))
        await validateTransferredTree(tree, concurrentStage)
        await expect(transfer(connection, tree, concurrentStage, 1)).rejects.toBeTruthy()
        await validateTransferredTree(tree, concurrentStage)

        const controller = new AbortController()
        let abortRequestedAt = 0
        const cancelled = await measure(async () => {
          const outcome = transfer(
            connection,
            tree,
            cancelledStage,
            4,
            controller.signal,
            (bytes) => {
              if (bytes > 0 && !controller.signal.aborted) {
                abortRequestedAt = performance.now()
                controller.abort(new Error('live SFTP cancellation'))
              }
            }
          )
          await expect(outcome).rejects.toThrow('live SFTP cancellation')
          return performance.now() - abortRequestedAt
        })
        await expect(lstat(cancelledStage)).rejects.toMatchObject({ code: 'ENOENT' })
        await new Promise((resolve) => setTimeout(resolve, 500))
        await expect(lstat(cancelledStage)).rejects.toMatchObject({ code: 'ENOENT' })

        const metrics = {
          tupleId: identity.tupleId,
          contentId: identity.contentId,
          files: tree.fileCount,
          bytes: tree.expandedBytes,
          serverVersion: process.env.ORCA_SSH_RELAY_LIVE_SFTP_SERVER_VERSION,
          runnerImage: process.env.ImageOS,
          runnerVersion: process.env.ImageVersion,
          runnerArchitecture: process.env.RUNNER_ARCH,
          serialElapsedMs: serial.elapsedMs,
          serialIncrementalRssBytes: serial.incrementalRssBytes,
          concurrentElapsedMs: concurrent.elapsedMs,
          concurrentIncrementalRssBytes: concurrent.incrementalRssBytes,
          cancellationSettlementMs: cancelled.result,
          cancellationIncrementalRssBytes: cancelled.incrementalRssBytes
        }
        console.log(`ssh_relay_live_sftp=${JSON.stringify(metrics)}`)
        expect(serial.result.bytesTransferred).toBe(tree.expandedBytes)
        expect(concurrent.result.bytesTransferred).toBe(tree.expandedBytes)
        expect(serial.incrementalRssBytes).toBeLessThanOrEqual(
          SSH_RELAY_RUNTIME_SOURCE_STREAM_LIMITS.maximumIncrementalMemoryBytes
        )
        expect(concurrent.incrementalRssBytes).toBeLessThanOrEqual(
          SSH_RELAY_RUNTIME_SOURCE_STREAM_LIMITS.maximumIncrementalMemoryBytes
        )
        expect(cancelled.result).toBeLessThan(10_000)
        expect(connection.getState().status).toBe('connected')
      } finally {
        await connection.disconnect()
        await Promise.all(
          [serialStage, concurrentStage, cancelledStage].map((stage) =>
            rm(stage, { recursive: true, force: true })
          )
        )
      }
    }
  )
})
