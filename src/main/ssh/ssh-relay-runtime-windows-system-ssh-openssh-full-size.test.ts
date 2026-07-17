import { createHash } from 'node:crypto'
import { lstat, open, opendir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import type { SshTarget } from '../../shared/ssh-types'
import { SshConnection } from './ssh-connection'
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
import { runSshRelayRuntimeWindowsStagingControl } from './ssh-relay-runtime-windows-staging-control'
import { transferSshRelayRuntimeTreeViaWindowsSystemSsh } from './ssh-relay-runtime-windows-tree-transfer'

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

const host = process.env.ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_HOST
const user = process.env.ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_USER
const identityFile = process.env.ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_IDENTITY
const clientHome = process.env.ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_CLIENT_HOME
const launcherPath = process.env.ORCA_SSH_WINDOWS_NO_INPUT_LAUNCHER
const remoteRoot = process.env.ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_REMOTE_ROOT
const serverVersion = process.env.ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_SERVER_VERSION
const fixtureArchiveSha256 = process.env.ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_ARCHIVE_SHA256
const powerShellVersion = process.env.ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_POWERSHELL_VERSION
const runtimeRoot = process.env.ORCA_SSH_RELAY_FULL_SIZE_RUNTIME_ROOT
const identityPath = process.env.ORCA_SSH_RELAY_FULL_SIZE_IDENTITY
const port = Number.parseInt(process.env.ORCA_SSH_RELAY_LIVE_WINDOWS_SYSTEM_SSH_PORT ?? '', 10)
const LIVE_STALL_TIMEOUT_MS = 60_000
const hasLiveInput = Boolean(
  host &&
  user &&
  identityFile &&
  clientHome &&
  launcherPath &&
  remoteRoot &&
  serverVersion &&
  fixtureArchiveSha256 &&
  powerShellVersion &&
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
    throw new Error('Live Windows system-SSH measurement identity is incomplete')
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
  // Why: the loopback runner can verify remote bytes without adding a second transfer mechanism.
  expect(await collectRemotePaths(stage)).toEqual(expectedPaths)
  for (const directory of tree.directories) {
    expect((await lstat(join(stage, ...directory.path.split('/')))).isDirectory()).toBe(true)
  }
  for (const file of tree.files) {
    const path = join(stage, ...file.path.split('/'))
    const metadata = await lstat(path)
    expect(metadata.isFile()).toBe(true)
    expect(metadata.size).toBe(file.size)
    expect(await hashFile(path)).toBe(file.sha256)
  }
}

function stagePath(name: string, identity: MeasurementIdentity): string {
  return join(remoteRoot as string, `${name}-${identity.contentId.slice('sha256:'.length, 23)}`)
}

function neutralNodeTree(tree: SshRelayRuntimeScannedSourceTree): SshRelayRuntimeScannedSourceTree {
  const node = tree.files.find((file) => file.path === 'bin/node.exe')
  const bin = tree.directories.find((directory) => directory.path === 'bin')
  if (!node || !bin) {
    throw new Error('Live Windows system-SSH runtime Node entry is missing')
  }
  // Why: identical authenticated bytes under a non-executable name distinguish streaming from
  // native endpoint-protection behavior before staging semantics are redesigned.
  return Object.freeze({
    ...tree,
    directories: Object.freeze([bin]),
    files: Object.freeze([Object.freeze({ ...node, path: 'bin/orca-node-payload.bin' })]),
    fileCount: 1,
    expandedBytes: node.size
  })
}

function logLivePhase(phase: string, details: Record<string, unknown> = {}): void {
  console.log(`ssh_relay_live_windows_system_ssh_phase=${JSON.stringify({ phase, ...details })}`)
}

function createProgressRecorder(
  phase: string,
  onActivity: () => void
): {
  record: (progress: SshRelayRuntimeSourceStreamProgress) => void
  snapshot: () => { bytes: number; updates: number; peakActiveFiles: number }
} {
  let bytes = 0
  let updates = 0
  let peakActiveFiles = 0
  let lastLoggedAt = 0
  let lastLoggedFiles = -1
  return {
    record: (progress) => {
      onActivity()
      bytes = progress.bytesTransferred
      updates += 1
      peakActiveFiles = Math.max(peakActiveFiles, progress.activeFiles)
      const now = performance.now()
      if (progress.filesCompleted !== lastLoggedFiles || now - lastLoggedAt >= 5_000) {
        lastLoggedAt = now
        lastLoggedFiles = progress.filesCompleted
        logLivePhase(`${phase}-progress`, {
          filesCompleted: progress.filesCompleted,
          totalFiles: progress.totalFiles,
          bytesTransferred: progress.bytesTransferred,
          totalBytes: progress.totalBytes,
          activeFiles: progress.activeFiles
        })
      }
    },
    snapshot: () => ({ bytes, updates, peakActiveFiles })
  }
}

function createLiveStallWatchdog(phase: string): {
  signal: AbortSignal
  activity: () => void
  dispose: () => void
} {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout>
  const activity = (): void => {
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      const error = new Error(`Live Windows system-SSH ${phase} stalled without progress`)
      logLivePhase(`${phase}-stalled`, { inactivityMs: LIVE_STALL_TIMEOUT_MS })
      controller.abort(error)
    }, LIVE_STALL_TIMEOUT_MS)
  }
  activity()
  return { signal: controller.signal, activity, dispose: () => clearTimeout(timeout) }
}

async function transfer(
  connection: SshConnection,
  tree: SshRelayRuntimeScannedSourceTree,
  stage: string,
  signal: AbortSignal,
  onProgress: (progress: SshRelayRuntimeSourceStreamProgress) => void,
  maximumConcurrency?: number
) {
  return transferSshRelayRuntimeTreeViaWindowsSystemSsh({
    connection,
    tree,
    remoteStagingRoot: stage,
    signal,
    onProgress,
    ...(maximumConcurrency === undefined ? {} : { maximumConcurrency })
  })
}

async function measureWatchedTransfer(
  connection: SshConnection,
  tree: SshRelayRuntimeScannedSourceTree,
  stage: string,
  phase: string,
  maximumConcurrency?: number
) {
  const watchdog = createLiveStallWatchdog(phase)
  const progress = createProgressRecorder(phase, watchdog.activity)
  logLivePhase(`${phase}-start`)
  try {
    const measurement = await measure(() =>
      transfer(connection, tree, stage, watchdog.signal, progress.record, maximumConcurrency)
    )
    logLivePhase(`${phase}-transfer-complete`, { elapsedMs: measurement.elapsedMs })
    return { measurement, progress }
  } finally {
    watchdog.dispose()
  }
}

describe.skipIf(!hasLiveInput)(
  'SSH relay full-size Windows system-SSH transfer through native OpenSSH',
  () => {
    it(
      'preserves exact bytes with bounded serial, concurrent, collision, and cancellation behavior',
      { timeout: 20 * 60_000 },
      async () => {
        expect(process.platform).toBe('win32')
        expect(process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT).toBe('1')
        expect(powerShellVersion).toMatch(/^5\.1\./u)
        expect(fixtureArchiveSha256).toMatch(/^[0-9a-f]{64}$/u)
        const identity = parseIdentity(JSON.parse(await readFile(identityPath as string, 'utf8')))
        expect(identity.os).toBe('win32')
        const tree = await scanSshRelayRuntimeSourceTree(
          sourceTree(identity),
          new AbortController().signal
        )
        const target: SshTarget = {
          id: 'live-windows-system-ssh-measurement',
          label: 'live-windows-system-ssh-measurement',
          host: host as string,
          port,
          username: user as string,
          identityFile: identityFile as string,
          identitiesOnly: true,
          systemSshConnectionReuse: true,
          source: 'manual'
        }
        // Why: native evidence must exercise the selected launcher adapter before packaging it.
        const connection = new SshConnection(
          target,
          { onStateChange: () => {} },
          {
            windowsNoInputLauncherPath: launcherPath as string,
            strictKnownHostsFile: join(clientHome as string, '.ssh', 'known_hosts')
          }
        )
        const serialStage = stagePath('system-serial', identity)
        const neutralNodeStage = stagePath('system-neutral-node', identity)
        const concurrentStage = stagePath('system-concurrent', identity)
        const cancelledStage = stagePath('system-cancelled', identity)
        const stages = [neutralNodeStage, serialStage, concurrentStage, cancelledStage]
        await Promise.all(stages.map((stage) => rm(stage, { recursive: true, force: true })))

        try {
          logLivePhase('connect-start')
          await connection.connect()
          expect(connection.usesSystemSshTransport()).toBe(true)
          logLivePhase('connect-complete')

          const neutralTree = neutralNodeTree(tree)
          const { measurement: neutralNode } = await measureWatchedTransfer(
            connection,
            neutralTree,
            neutralNodeStage,
            'neutral-node'
          )
          logLivePhase('neutral-node-validation-start')
          await validateTransferredTree(neutralTree, neutralNodeStage)
          logLivePhase('neutral-node-validation-complete', { elapsedMs: neutralNode.elapsedMs })
          await runSshRelayRuntimeWindowsStagingControl({
            operation: 'remove-root',
            remoteRoot: neutralNodeStage,
            signal: new AbortController().signal,
            openChannel: (command, signal) =>
              openSshRelayRuntimeSystemSshFileChannel(connection, command, signal, 'powershell')
          })
          logLivePhase('neutral-node-cleanup-complete')

          const { measurement: serial, progress: serialProgress } = await measureWatchedTransfer(
            connection,
            tree,
            serialStage,
            'serial'
          )
          logLivePhase('serial-validation-start')
          await validateTransferredTree(tree, serialStage)
          logLivePhase('serial-validation-complete')
          expect(serialProgress.snapshot().peakActiveFiles).toBe(1)

          const { measurement: concurrent, progress: concurrentProgress } =
            await measureWatchedTransfer(connection, tree, concurrentStage, 'concurrent', 4)
          logLivePhase('concurrent-validation-start')
          await validateTransferredTree(tree, concurrentStage)
          logLivePhase('concurrent-validation-complete')
          expect(concurrentProgress.snapshot().peakActiveFiles).toBeGreaterThan(1)
          expect(concurrentProgress.snapshot().peakActiveFiles).toBeLessThanOrEqual(4)
          logLivePhase('collision-start')
          await expect(
            transfer(connection, tree, concurrentStage, new AbortController().signal, () => {})
          ).rejects.toBeTruthy()
          await validateTransferredTree(tree, concurrentStage)
          logLivePhase('collision-complete')

          const controller = new AbortController()
          const cancelledProgress = createProgressRecorder('cancellation', () => {})
          let abortRequestedAt = 0
          logLivePhase('cancellation-start')
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
                  controller.abort(new Error('live Windows system-SSH cancellation'))
                }
              },
              4
            )
            await expect(outcome).rejects.toThrow('live Windows system-SSH cancellation')
            return performance.now() - abortRequestedAt
          })
          const updatesAfterSettlement = cancelledProgress.snapshot().updates
          await expect(lstat(cancelledStage)).rejects.toMatchObject({ code: 'ENOENT' })
          await new Promise((resolve) => setTimeout(resolve, 500))
          await expect(lstat(cancelledStage)).rejects.toMatchObject({ code: 'ENOENT' })
          expect(cancelledProgress.snapshot().updates).toBe(updatesAfterSettlement)
          logLivePhase('cancellation-complete', { settlementMs: cancelled.result })

          logLivePhase('reuse-cleanup-start')
          await runSshRelayRuntimeWindowsStagingControl({
            operation: 'remove-root',
            remoteRoot: cancelledStage,
            signal: new AbortController().signal,
            openChannel: (command, signal) =>
              openSshRelayRuntimeSystemSshFileChannel(connection, command, signal, 'powershell')
          })
          expect(connection.getState().status).toBe('connected')
          logLivePhase('reuse-cleanup-complete')

          const metrics = {
            tupleId: identity.tupleId,
            contentId: identity.contentId,
            files: tree.fileCount,
            bytes: tree.expandedBytes,
            serverVersion,
            fixtureArchiveSha256,
            powerShellVersion,
            runnerImage: process.env.ImageOS,
            runnerVersion: process.env.ImageVersion,
            runnerArchitecture: process.env.RUNNER_ARCH,
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
          console.log(`ssh_relay_live_windows_system_ssh=${JSON.stringify(metrics)}`)
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
          logLivePhase('disconnect-start')
          await connection.disconnect()
          logLivePhase('disconnect-complete')
          logLivePhase('final-cleanup-start')
          await Promise.all(stages.map((stage) => rm(stage, { recursive: true, force: true })))
          logLivePhase('final-cleanup-complete')
        }
      }
    )
  }
)
