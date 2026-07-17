import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { publishSshRelayArtifactCacheEntry } from './ssh-relay-artifact-cache-entry'
import { createSshRelayArtifactCacheEntryFixture } from './ssh-relay-artifact-cache-entry-fixture'
import {
  acquireSshRelayArtifactCacheInUseLease,
  type SshRelayArtifactCacheInUseLease
} from './ssh-relay-artifact-cache-in-use-lease'
import { scanSshRelayRuntimeSourceTree } from './ssh-relay-runtime-source-scan'
import { createSshRelayRuntimeSourceTree } from './ssh-relay-runtime-source-tree'
import type { SshRelayRuntimeSystemSshConnection } from './ssh-relay-runtime-system-ssh-file-channel'
import {
  transferSshRelayRuntimeTreeViaWindowsSystemSsh,
  SSH_RELAY_RUNTIME_WINDOWS_TREE_TRANSFER_LIMITS
} from './ssh-relay-runtime-windows-tree-transfer'

const stagingControl = vi.hoisted(() => vi.fn())
const openFileDestination = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-runtime-windows-staging-control', () => ({
  runSshRelayRuntimeWindowsStagingControl: stagingControl
}))
vi.mock('./ssh-relay-runtime-windows-file-destination', () => ({
  openSshRelayRuntimeWindowsFileDestination: openFileDestination
}))

const cleanupRoots = new Set<string>()
const cleanupLeases = new Set<SshRelayArtifactCacheInUseLease>()

async function treeFixture(os: 'win32' | 'linux' = 'win32') {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-windows-tree-'))
  cleanupRoots.add(root)
  const inputRoot = join(root, 'input')
  await mkdir(inputRoot)
  const fixture = await createSshRelayArtifactCacheEntryFixture({ root: inputRoot, os })
  const cacheRoot = join(root, 'cache')
  const entry = await publishSshRelayArtifactCacheEntry({
    cacheRoot,
    artifact: fixture.artifact,
    archivePath: fixture.archivePath
  })
  const lease = await acquireSshRelayArtifactCacheInUseLease({ cacheRoot, entry })
  cleanupLeases.add(lease)
  const source = createSshRelayRuntimeSourceTree({
    kind: 'ready',
    source: 'cache',
    artifact: fixture.artifact,
    entry,
    lease
  })
  return scanSshRelayRuntimeSourceTree(source, new AbortController().signal)
}

function connection(system = true): SshRelayRuntimeSystemSshConnection {
  return { usesSystemSshTransport: () => system, exec: vi.fn() }
}

function retainDestinationWrites() {
  let active = 0
  let peak = 0
  let holding = true
  const pending = new Set<() => void>()
  openFileDestination.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
    active += 1
    peak = Math.max(peak, active)
    let owned = true
    const settle = (): void => {
      if (owned) {
        owned = false
        active -= 1
      }
    }
    return {
      write: vi.fn(() => {
        if (!holding) {
          return Promise.resolve()
        }
        return new Promise<void>((resolve, reject) => {
          const release = (): void => {
            signal.removeEventListener('abort', onAbort)
            pending.delete(release)
            resolve()
          }
          const onAbort = (): void => {
            pending.delete(release)
            reject(signal.reason)
          }
          pending.add(release)
          signal.addEventListener('abort', onAbort, { once: true })
        })
      }),
      close: vi.fn(async () => settle()),
      abort: vi.fn(async () => settle())
    }
  })
  return {
    peak: () => peak,
    release: () => {
      holding = false
      for (const release of pending) {
        release()
      }
    }
  }
}

beforeEach(() => {
  stagingControl.mockReset().mockResolvedValue(undefined)
  openFileDestination.mockReset().mockImplementation(async () => ({
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {})
  }))
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all([...cleanupLeases].map((lease) => lease.release().catch(() => {})))
  cleanupLeases.clear()
  await Promise.all([...cleanupRoots].map((root) => rm(root, { recursive: true, force: true })))
  cleanupRoots.clear()
})

describe('SSH relay runtime Windows system-SSH tree transfer', () => {
  it('rejects POSIX trees, unsafe roots, transport, concurrency, and pre-abort before I/O', async () => {
    const windows = await treeFixture()
    const linux = await treeFixture('linux')
    const signal = new AbortController().signal
    for (const options of [
      { tree: linux, connection: connection(), remoteStagingRoot: 'C:/stage', signal },
      { tree: windows, connection: connection(), remoteStagingRoot: '../stage', signal },
      { tree: windows, connection: connection(), remoteStagingRoot: 'C:/CON/stage', signal },
      { tree: windows, connection: connection(), remoteStagingRoot: '//server/share', signal },
      { tree: windows, connection: connection(false), remoteStagingRoot: 'C:/stage', signal },
      {
        tree: windows,
        connection: connection(),
        remoteStagingRoot: 'C:/stage',
        maximumConcurrency: 5,
        signal
      }
    ]) {
      await expect(transferSshRelayRuntimeTreeViaWindowsSystemSsh(options)).rejects.toThrow()
    }
    const controller = new AbortController()
    const reason = new Error('pre-aborted')
    controller.abort(reason)
    await expect(
      transferSshRelayRuntimeTreeViaWindowsSystemSsh({
        tree: windows,
        connection: connection(),
        remoteStagingRoot: 'C:/stage',
        signal: controller.signal
      })
    ).rejects.toBe(reason)
    expect(stagingControl).not.toHaveBeenCalled()
    expect(openFileDestination).not.toHaveBeenCalled()
  })

  it('creates parent-first directories and streams every exact file before returning progress', async () => {
    const tree = await treeFixture()
    const remoteRoot = 'C:/Users/测试/.orca/stage'
    const written = new Map<string, Buffer>()
    const events: string[] = []
    stagingControl.mockImplementation(async ({ operation, remotePath }) => {
      events.push(operation === 'create-directory' ? `directory:${remotePath}` : operation)
    })
    openFileDestination.mockImplementation(
      async ({ remotePath, expectedSize, signal, openChannel }) => {
        events.push(`file:${remotePath}`)
        expect(expectedSize).toBe(tree.files.find((file) => remotePath.endsWith(file.path))?.size)
        expect(signal).toBeInstanceOf(AbortSignal)
        expect(openChannel).toBeTypeOf('function')
        return {
          write: vi.fn(async (chunk: Buffer) => {
            written.set(
              remotePath,
              Buffer.concat([written.get(remotePath) ?? Buffer.alloc(0), chunk])
            )
          }),
          close: vi.fn(async () => {}),
          abort: vi.fn(async () => {})
        }
      }
    )
    const progress: unknown[] = []
    const result = await transferSshRelayRuntimeTreeViaWindowsSystemSsh({
      tree,
      connection: connection(),
      remoteStagingRoot: remoteRoot,
      maximumConcurrency: 2,
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value)
    })

    expect(result).toMatchObject({
      remoteStagingRoot: remoteRoot,
      filesCompleted: tree.fileCount,
      totalFiles: tree.fileCount,
      bytesTransferred: tree.expandedBytes,
      totalBytes: tree.expandedBytes
    })
    expect(stagingControl.mock.calls[0]?.[0]).toMatchObject({
      operation: 'create-root',
      remoteRoot
    })
    const directoryCalls = stagingControl.mock.calls.slice(1).map(([value]) => value)
    const expectedDirectories = [...tree.directories]
      .sort(
        (left, right) =>
          left.path.split('/').length - right.path.split('/').length ||
          (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
      )
      .map((directory) => ({
        operation: 'create-directory',
        remoteRoot,
        remotePath: `${remoteRoot}/${directory.path}`
      }))
    expect(directoryCalls).toEqual(
      expectedDirectories.map((value) => expect.objectContaining(value))
    )
    expect(events.findIndex((event) => event.startsWith('file:'))).toBe(tree.directories.length + 1)
    for (const file of tree.files) {
      const remotePath = `${remoteRoot}/${file.path}`
      expect(written.get(remotePath)).toEqual(await readFile(file.localPath))
      expect(openFileDestination).toHaveBeenCalledWith(
        expect.objectContaining({ remotePath, expectedSize: file.size })
      )
    }
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toMatchObject({
      filesCompleted: tree.fileCount,
      bytesTransferred: tree.expandedBytes,
      activeFiles: 0
    })
    expect(progress.some((value) => 'path' in (value as object))).toBe(false)
  })

  it('does not clean a pre-existing root when exclusive creation fails', async () => {
    const tree = await treeFixture()
    const collision = new Error('root exists')
    stagingControl.mockRejectedValueOnce(collision)
    await expect(
      transferSshRelayRuntimeTreeViaWindowsSystemSsh({
        tree,
        connection: connection(),
        remoteStagingRoot: 'C:/existing/stage',
        signal: new AbortController().signal
      })
    ).rejects.toBe(collision)
    expect(stagingControl).toHaveBeenCalledOnce()
  })

  it('defaults to one active destination and permits no more than four', async () => {
    const tree = await treeFixture()
    for (const maximumConcurrency of [undefined, 4]) {
      const retained = retainDestinationWrites()
      const transfer = transferSshRelayRuntimeTreeViaWindowsSystemSsh({
        tree,
        connection: connection(),
        remoteStagingRoot: 'C:/private/stage',
        maximumConcurrency,
        signal: new AbortController().signal
      })
      const expected = maximumConcurrency ?? 1
      await vi.waitFor(() => expect(retained.peak()).toBe(expected))
      retained.release()
      await transfer
      expect(retained.peak()).toBeLessThanOrEqual(expected)
      openFileDestination.mockReset()
    }
  })

  it('cleans an owned root after a directory failure', async () => {
    const tree = await treeFixture()
    const primary = new Error('directory denied')
    stagingControl.mockImplementation(async ({ operation }) => {
      if (operation === 'create-directory') {
        throw primary
      }
    })
    await expect(
      transferSshRelayRuntimeTreeViaWindowsSystemSsh({
        tree,
        connection: connection(),
        remoteStagingRoot: 'C:/private/stage',
        signal: new AbortController().signal
      })
    ).rejects.toBe(primary)
    expect(stagingControl.mock.calls.map(([value]) => value.operation)).toEqual([
      'create-root',
      'create-directory',
      'remove-root'
    ])
  })

  it('joins file and owned-root cleanup failures', async () => {
    const tree = await treeFixture()
    const primary = new Error('remote disk full')
    const cleanup = new Error('endpoint protection lock')
    openFileDestination.mockRejectedValueOnce(primary)
    stagingControl.mockImplementation(async ({ operation }: { operation: string }) => {
      if (operation === 'remove-root') {
        throw cleanup
      }
    })
    await expect(
      transferSshRelayRuntimeTreeViaWindowsSystemSsh({
        tree,
        connection: connection(),
        remoteStagingRoot: 'C:/private/stage',
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ errors: expect.arrayContaining([primary, cleanup]) })
    expect(stagingControl.mock.calls.at(-1)?.[0]).toMatchObject({ operation: 'remove-root' })
  })

  it('settles a retained write before cleanup on cancellation and emits no later progress', async () => {
    const tree = await treeFixture()
    const controller = new AbortController()
    const reason = new Error('cancelled Windows tree transfer')
    const events: string[] = []
    const progress: unknown[] = []
    stagingControl.mockImplementation(async ({ operation }) => events.push(operation))
    openFileDestination.mockImplementation(async ({ signal }: { signal: AbortSignal }) => ({
      write: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            events.push('write-start')
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
      ),
      close: vi.fn(async () => events.push('file-close')),
      abort: vi.fn(async () => events.push('file-abort'))
    }))
    const transfer = transferSshRelayRuntimeTreeViaWindowsSystemSsh({
      tree,
      connection: connection(),
      remoteStagingRoot: 'C:/private/stage',
      signal: controller.signal,
      onProgress: (value) => progress.push(value)
    })
    await vi.waitFor(() => expect(events).toContain('write-start'))
    controller.abort(reason)
    await expect(transfer).rejects.toBe(reason)
    expect(events.indexOf('file-abort')).toBeLessThan(events.indexOf('remove-root'))
    const settledProgress = progress.length
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(progress).toHaveLength(settledProgress)
  })

  it('bounds unresponsive owned-root cleanup below ten seconds', async () => {
    const tree = await treeFixture()
    vi.useFakeTimers()
    const primary = new Error('file open failed')
    openFileDestination.mockRejectedValueOnce(primary)
    stagingControl.mockImplementation(({ operation, signal }) => {
      if (operation !== 'remove-root') {
        return Promise.resolve()
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const startedAt = Date.now()
    const transfer = transferSshRelayRuntimeTreeViaWindowsSystemSsh({
      tree,
      connection: connection(),
      remoteStagingRoot: 'C:/private/stage',
      signal: new AbortController().signal
    })
    const rejection = expect(transfer).rejects.toMatchObject({
      errors: expect.arrayContaining([
        primary,
        expect.objectContaining({ message: expect.stringMatching(/cleanup timed out/i) })
      ])
    })
    await vi.waitFor(() =>
      expect(stagingControl.mock.calls.at(-1)?.[0]).toMatchObject({ operation: 'remove-root' })
    )
    await vi.advanceTimersByTimeAsync(
      SSH_RELAY_RUNTIME_WINDOWS_TREE_TRANSFER_LIMITS.cleanupTimeoutMs
    )
    await rejection
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  })
})
