import { createHash } from 'node:crypto'
import { lstat, open, opendir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import type { SshTarget } from '../../shared/ssh-types'
import { SshConnection } from './ssh-connection'
import { runSshRelayRuntimePosixControlCommand } from './ssh-relay-runtime-posix-control-command'
import { transferSshRelayRuntimeTreeViaPosixSystemSsh } from './ssh-relay-runtime-posix-tree-transfer'
import {
  scanSshRelayRuntimeSourceTree,
  type SshRelayRuntimeScannedSourceTree
} from './ssh-relay-runtime-source-scan'
import type { SshRelayRuntimeSourceTree } from './ssh-relay-runtime-source-tree'
import {
  SSH_RELAY_RUNTIME_SOURCE_STREAM_LIMITS,
  type SshRelayRuntimeSourceStreamProgress
} from './ssh-relay-runtime-source-stream'
import { openSshRelayRuntimeSystemSshFileChannel } from './ssh-relay-runtime-system-ssh-file-channel'

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

const host = process.env.ORCA_SSH_RELAY_LIVE_SYSTEM_SSH_HOST
const user = process.env.ORCA_SSH_RELAY_LIVE_SYSTEM_SSH_USER
const identityFile = process.env.ORCA_SSH_RELAY_LIVE_SYSTEM_SSH_IDENTITY
const remoteRoot = process.env.ORCA_SSH_RELAY_LIVE_SYSTEM_SSH_REMOTE_ROOT
const runtimeRoot = process.env.ORCA_SSH_RELAY_FULL_SIZE_RUNTIME_ROOT
const identityPath = process.env.ORCA_SSH_RELAY_FULL_SIZE_IDENTITY
const port = Number.parseInt(process.env.ORCA_SSH_RELAY_LIVE_SYSTEM_SSH_PORT ?? '', 10)
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
    throw new Error('Live POSIX system-SSH measurement identity is incomplete')
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

function createProgressRecorder(): {
  record: (progress: SshRelayRuntimeSourceStreamProgress) => void
  snapshot: () => { bytes: number; updates: number; peakActiveFiles: number }
} {
  let bytes = 0
  let updates = 0
  let peakActiveFiles = 0
  return {
    record: (progress) => {
      bytes = progress.bytesTransferred
      updates += 1
      peakActiveFiles = Math.max(peakActiveFiles, progress.activeFiles)
    },
    snapshot: () => ({ bytes, updates, peakActiveFiles })
  }
}

async function transfer(
  connection: SshConnection,
  tree: SshRelayRuntimeScannedSourceTree,
  stage: string,
  signal: AbortSignal,
  onProgress: (progress: SshRelayRuntimeSourceStreamProgress) => void,
  maximumConcurrency?: number
) {
  return transferSshRelayRuntimeTreeViaPosixSystemSsh({
    connection,
    tree,
    remoteStagingRoot: stage,
    signal,
    onProgress,
    ...(maximumConcurrency === undefined ? {} : { maximumConcurrency })
  })
}

describe.skipIf(!hasLiveInput)(
  'SSH relay full-size POSIX system-SSH transfer through restricted OpenSSH',
  () => {
    it(
      'preserves exact bytes and modes with bounded serial, concurrent, and cancellation behavior',
      { timeout: 20 * 60_000 },
      async () => {
        expect(process.platform).toBe('linux')
        expect(process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT).toBe('1')
        const identity = parseIdentity(JSON.parse(await readFile(identityPath as string, 'utf8')))
        expect(identity.os).toBe('linux')
        const tree = await scanSshRelayRuntimeSourceTree(
          sourceTree(identity),
          new AbortController().signal
        )
        const target: SshTarget = {
          id: 'live-posix-system-ssh-measurement',
          label: 'live-posix-system-ssh-measurement',
          host: host as string,
          port,
          username: user as string,
          identityFile: identityFile as string,
          identitiesOnly: true,
          systemSshConnectionReuse: true,
          source: 'manual'
        }
        const connection = new SshConnection(target, { onStateChange: () => {} })
        const serialStage = stagePath('system-serial', identity)
        const concurrentStage = stagePath('system-concurrent', identity)
        const cancelledStage = stagePath('system-cancelled', identity)
        const stages = [serialStage, concurrentStage, cancelledStage]
        await Promise.all(stages.map((stage) => rm(stage, { recursive: true, force: true })))

        try {
          await connection.connect()
          expect(connection.usesSystemSshTransport()).toBe(true)

          const serialProgress = createProgressRecorder()
          const serial = await measure(() =>
            transfer(
              connection,
              tree,
              serialStage,
              new AbortController().signal,
              serialProgress.record
            )
          )
          await validateTransferredTree(tree, serialStage)
          expect(serialProgress.snapshot().peakActiveFiles).toBe(1)

          const concurrentProgress = createProgressRecorder()
          const concurrent = await measure(() =>
            transfer(
              connection,
              tree,
              concurrentStage,
              new AbortController().signal,
              concurrentProgress.record,
              4
            )
          )
          await validateTransferredTree(tree, concurrentStage)
          expect(concurrentProgress.snapshot().peakActiveFiles).toBeGreaterThan(1)
          expect(concurrentProgress.snapshot().peakActiveFiles).toBeLessThanOrEqual(4)
          await expect(
            transfer(connection, tree, concurrentStage, new AbortController().signal, () => {})
          ).rejects.toBeTruthy()
          await validateTransferredTree(tree, concurrentStage)

          const controller = new AbortController()
          const cancelledProgress = createProgressRecorder()
          let abortRequestedAt = 0
          const cancelled = await measure(async () => {
            const outcome = transfer(
              connection,
              tree,
              cancelledStage,
              controller.signal,
              (progress) => {
                cancelledProgress.record(progress)
                if (progress.bytesTransferred > 0 && !controller.signal.aborted) {
                  abortRequestedAt = performance.now()
                  controller.abort(new Error('live POSIX system-SSH cancellation'))
                }
              },
              4
            )
            await expect(outcome).rejects.toThrow('live POSIX system-SSH cancellation')
            return performance.now() - abortRequestedAt
          })
          const updatesAfterSettlement = cancelledProgress.snapshot().updates
          await expect(lstat(cancelledStage)).rejects.toMatchObject({ code: 'ENOENT' })
          await new Promise((resolve) => setTimeout(resolve, 500))
          await expect(lstat(cancelledStage)).rejects.toMatchObject({ code: 'ENOENT' })
          expect(cancelledProgress.snapshot().updates).toBe(updatesAfterSettlement)

          await runSshRelayRuntimePosixControlCommand({
            command: 'true',
            signal: new AbortController().signal,
            openChannel: (command, signal) =>
              openSshRelayRuntimeSystemSshFileChannel(connection, command, signal, 'posix')
          })
          expect(connection.getState().status).toBe('connected')

          const metrics = {
            tupleId: identity.tupleId,
            contentId: identity.contentId,
            files: tree.fileCount,
            bytes: tree.expandedBytes,
            serverVersion: process.env.ORCA_SSH_RELAY_LIVE_SYSTEM_SSH_SERVER_VERSION,
            runnerImage: process.env.ImageOS,
            runnerVersion: process.env.ImageVersion,
            runnerArchitecture: process.env.RUNNER_ARCH,
            remotePrimitives: ['/bin/sh', 'mkdir', 'chmod', 'cat', 'rm'],
            serialElapsedMs: serial.elapsedMs,
            serialIncrementalRssBytes: serial.incrementalRssBytes,
            serialPeakActiveFiles: serialProgress.snapshot().peakActiveFiles,
            concurrentElapsedMs: concurrent.elapsedMs,
            concurrentIncrementalRssBytes: concurrent.incrementalRssBytes,
            concurrentPeakActiveFiles: concurrentProgress.snapshot().peakActiveFiles,
            cancellationSettlementMs: cancelled.result,
            cancellationIncrementalRssBytes: cancelled.incrementalRssBytes,
            cancellationProgressUpdates: cancelledProgress.snapshot().updates
          }
          console.log(`ssh_relay_live_posix_system_ssh=${JSON.stringify(metrics)}`)
          expect(serial.result.bytesTransferred).toBe(tree.expandedBytes)
          expect(concurrent.result.bytesTransferred).toBe(tree.expandedBytes)
          expect(serialProgress.snapshot().bytes).toBe(tree.expandedBytes)
          expect(concurrentProgress.snapshot().bytes).toBe(tree.expandedBytes)
          expect(serial.incrementalRssBytes).toBeLessThanOrEqual(
            SSH_RELAY_RUNTIME_SOURCE_STREAM_LIMITS.maximumIncrementalMemoryBytes
          )
          expect(concurrent.incrementalRssBytes).toBeLessThanOrEqual(
            SSH_RELAY_RUNTIME_SOURCE_STREAM_LIMITS.maximumIncrementalMemoryBytes
          )
          expect(cancelled.result).toBeLessThan(10_000)
        } finally {
          await connection.disconnect()
          await Promise.all(stages.map((stage) => rm(stage, { recursive: true, force: true })))
        }
      }
    )
  }
)
