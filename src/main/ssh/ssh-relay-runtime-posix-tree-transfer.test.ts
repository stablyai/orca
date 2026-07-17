import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { publishSshRelayArtifactCacheEntry } from './ssh-relay-artifact-cache-entry'
import { createSshRelayArtifactCacheEntryFixture } from './ssh-relay-artifact-cache-entry-fixture'
import {
  acquireSshRelayArtifactCacheInUseLease,
  type SshRelayArtifactCacheInUseLease
} from './ssh-relay-artifact-cache-in-use-lease'
import { scanSshRelayRuntimeSourceTree } from './ssh-relay-runtime-source-scan'
import {
  transferSshRelayRuntimeTreeViaPosixSystemSsh,
  SSH_RELAY_RUNTIME_POSIX_TREE_TRANSFER_LIMITS
} from './ssh-relay-runtime-posix-tree-transfer'
import { createSshRelayRuntimeSourceTree } from './ssh-relay-runtime-source-tree'
import type { SshRelayRuntimeSystemSshConnection } from './ssh-relay-runtime-system-ssh-file-channel'

type WriteCallback = (error?: Error) => void
type FakeChannel = EventEmitter & {
  stdin: { write: (chunk: Buffer, callback: WriteCallback) => boolean; end: () => void }
  stderr: EventEmitter
  resume: () => FakeChannel
  close: () => void
  _process: ChildProcess
}

type ConnectionBehavior = {
  rootExit?: number
  cleanupExit?: number
  writeError?: Error
  retainFirstWrite?: boolean
  hangCleanup?: boolean
}

const cleanupRoots = new Set<string>()
const cleanupLeases = new Set<SshRelayArtifactCacheInUseLease>()

async function treeFixture(os: 'linux' | 'win32' = 'linux') {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-posix-tree-'))
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

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function createConnection(behavior: ConnectionBehavior = {}): {
  connection: SshRelayRuntimeSystemSshConnection
  commands: string[]
  fileBytes: Map<string, Buffer>
  writes: () => number
  peakFiles: () => number
  releaseWrites: () => void
} {
  const commands: string[] = []
  const fileBytes = new Map<string, Buffer>()
  const retainedWrites: WriteCallback[] = []
  let writeCount = 0
  let activeFiles = 0
  let peakFiles = 0
  let writeFailed = false
  let writeRetained = false

  const exec = vi.fn(async (command: string) => {
    commands.push(command)
    const isFile = command.includes('; cat > ')
    const isCleanup = command.startsWith('rm -rf ')
    const isRoot = command.startsWith('umask 077; mkdir ') && !command.includes(' && chmod ')
    const channel = new EventEmitter() as FakeChannel
    let closed = false
    const emitClose = (code: number | null, signal?: NodeJS.Signals | null): void => {
      if (closed) {
        return
      }
      closed = true
      if (isFile) {
        activeFiles -= 1
      }
      queueMicrotask(() => channel.emit('close', code, signal))
    }
    if (isFile) {
      activeFiles += 1
      peakFiles = Math.max(peakFiles, activeFiles)
      fileBytes.set(command, Buffer.alloc(0))
    }
    channel.stderr = new EventEmitter()
    channel.resume = () => channel
    channel.stdin = {
      write: (chunk, callback) => {
        writeCount += 1
        if (behavior.writeError && !writeFailed) {
          writeFailed = true
          callback(behavior.writeError)
          return true
        }
        const current = fileBytes.get(command) ?? Buffer.alloc(0)
        fileBytes.set(command, Buffer.concat([current, Buffer.from(chunk)]))
        if (behavior.retainFirstWrite && !writeRetained) {
          writeRetained = true
          retainedWrites.push(callback)
          return true
        }
        callback()
        return true
      },
      end: () => {
        if (isCleanup && behavior.hangCleanup) {
          return
        }
        const code = isCleanup ? (behavior.cleanupExit ?? 0) : isRoot ? (behavior.rootExit ?? 0) : 0
        if (code !== 0) {
          channel.stderr.emit('data', Buffer.from('remote command rejected'))
        }
        emitClose(code, null)
      }
    }
    channel.close = () => {
      if (isCleanup && behavior.hangCleanup) {
        return
      }
      emitClose(null, 'SIGTERM')
    }
    channel._process = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => {
        if (!isCleanup || !behavior.hangCleanup) {
          emitClose(null, 'SIGKILL')
        }
        return true
      })
    } as unknown as ChildProcess
    return channel as unknown as ClientChannel
  })
  return {
    connection: { usesSystemSshTransport: () => true, exec },
    commands,
    fileBytes,
    writes: () => writeCount,
    peakFiles: () => peakFiles,
    releaseWrites: () => retainedWrites.splice(0).forEach((callback) => callback())
  }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all([...cleanupLeases].map((lease) => lease.release().catch(() => {})))
  cleanupLeases.clear()
  await Promise.all([...cleanupRoots].map((root) => rm(root, { recursive: true, force: true })))
  cleanupRoots.clear()
})

describe('SSH relay runtime POSIX system-SSH tree transfer', () => {
  it('rejects Windows, unsafe roots, and invalid concurrency before exec', async () => {
    const windows = await treeFixture('win32')
    const linux = await treeFixture()
    const fixture = createConnection()
    const base = {
      connection: fixture.connection,
      signal: new AbortController().signal
    }

    await expect(
      transferSshRelayRuntimeTreeViaPosixSystemSsh({
        ...base,
        tree: windows,
        remoteStagingRoot: '/stage/content'
      })
    ).rejects.toThrow(/POSIX tree/i)
    await expect(
      transferSshRelayRuntimeTreeViaPosixSystemSsh({
        ...base,
        tree: linux,
        remoteStagingRoot: '../stage'
      })
    ).rejects.toThrow(/staging root/i)
    await expect(
      transferSshRelayRuntimeTreeViaPosixSystemSsh({
        ...base,
        tree: linux,
        remoteStagingRoot: undefined as unknown as string
      })
    ).rejects.toThrow(/staging root/i)
    await expect(
      transferSshRelayRuntimeTreeViaPosixSystemSsh({
        ...base,
        tree: linux,
        remoteStagingRoot: '/stage/content',
        maximumConcurrency: 5
      })
    ).rejects.toThrow(/concurrency/i)
    expect(fixture.commands).toEqual([])
  })

  it('creates an exclusive tree, streams exact bytes/modes, and returns progress', async () => {
    const tree = await treeFixture()
    const fixture = createConnection()
    const root = "/tmp/orca user's/content"
    const progress: unknown[] = []
    const result = await transferSshRelayRuntimeTreeViaPosixSystemSsh({
      tree,
      connection: fixture.connection,
      remoteStagingRoot: root,
      maximumConcurrency: 2,
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value)
    })

    expect(result).toMatchObject({
      remoteStagingRoot: root,
      filesCompleted: tree.fileCount,
      bytesTransferred: tree.expandedBytes
    })
    expect(fixture.commands[0]).toBe(`umask 077; mkdir ${quote(root)}`)
    const firstFile = fixture.commands.findIndex((command) => command.includes('; cat > '))
    const lastDirectory = fixture.commands.findLastIndex(
      (command) => command.includes(' && chmod ') && !command.includes('; cat > ')
    )
    expect(firstFile).toBeGreaterThan(lastDirectory)
    const expectedDirectoryCommands = [...tree.directories]
      .sort(
        (left, right) =>
          left.path.split('/').length - right.path.split('/').length ||
          (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
      )
      .map((directory) => {
        const remotePath = `${root}/${directory.path}`
        return `umask 077; mkdir ${quote(remotePath)} && chmod 0755 ${quote(remotePath)}`
      })
    expect(fixture.commands.slice(1, firstFile)).toEqual(expectedDirectoryCommands)
    for (const forbidden of ['node ', 'python', 'perl', 'tar ', 'base64', 'sha256sum', 'shasum']) {
      expect(fixture.commands.join('\n')).not.toContain(forbidden)
    }
    for (const file of tree.files) {
      const remotePath = `${root}/${file.path}`
      const command = fixture.commands.find(
        (candidate) =>
          candidate.includes(`cat > ${quote(remotePath)}`) &&
          candidate.includes(`chmod ${file.mode.toString(8).padStart(4, '0')} ${quote(remotePath)}`)
      )
      expect(command).toBeDefined()
      expect(fixture.fileBytes.get(command as string)).toEqual(await readFile(file.localPath))
    }
    expect(progress.length).toBeGreaterThan(0)
  })

  it('does not clean a pre-existing root when exclusive creation fails', async () => {
    const tree = await treeFixture()
    const fixture = createConnection({ rootExit: 1 })
    await expect(
      transferSshRelayRuntimeTreeViaPosixSystemSsh({
        tree,
        connection: fixture.connection,
        remoteStagingRoot: '/existing/content',
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/exit 1/i)
    expect(fixture.commands.some((command) => command.startsWith('rm -rf '))).toBe(false)
  })

  it('permits at most four active file channels', async () => {
    const tree = await treeFixture()
    const fixture = createConnection({ retainFirstWrite: true })
    const transfer = transferSshRelayRuntimeTreeViaPosixSystemSsh({
      tree,
      connection: fixture.connection,
      remoteStagingRoot: '/stage/content',
      maximumConcurrency: 4,
      signal: new AbortController().signal
    })

    await vi.waitFor(() => expect(fixture.peakFiles()).toBe(Math.min(4, tree.fileCount)))
    fixture.releaseWrites()
    await transfer
    expect(fixture.peakFiles()).toBeLessThanOrEqual(4)
  })

  it('defaults to one active file channel', async () => {
    const tree = await treeFixture()
    const fixture = createConnection({ retainFirstWrite: true })
    const transfer = transferSshRelayRuntimeTreeViaPosixSystemSsh({
      tree,
      connection: fixture.connection,
      remoteStagingRoot: '/stage/content',
      signal: new AbortController().signal
    })

    await vi.waitFor(() => expect(fixture.peakFiles()).toBe(1))
    fixture.releaseWrites()
    await transfer
    expect(fixture.peakFiles()).toBe(1)
  })

  it('settles retained writes before cleaning its owned root on cancellation', async () => {
    const tree = await treeFixture()
    const fixture = createConnection({ retainFirstWrite: true })
    const controller = new AbortController()
    const reason = new Error('cancelled tree transfer')
    const transfer = transferSshRelayRuntimeTreeViaPosixSystemSsh({
      tree,
      connection: fixture.connection,
      remoteStagingRoot: '/stage/content',
      signal: controller.signal
    })

    await vi.waitFor(() => expect(fixture.writes()).toBe(1))
    controller.abort(reason)
    await expect(transfer).rejects.toBe(reason)
    expect(fixture.commands.at(-1)).toBe("rm -rf '/stage/content'")
    expect(fixture.writes()).toBe(1)
  })

  it('joins transfer and owned-root cleanup failures', async () => {
    const tree = await treeFixture()
    const primary = new Error('remote disk full')
    const fixture = createConnection({ writeError: primary, cleanupExit: 9 })
    const transfer = transferSshRelayRuntimeTreeViaPosixSystemSsh({
      tree,
      connection: fixture.connection,
      remoteStagingRoot: '/private/content',
      signal: new AbortController().signal
    })

    await expect(transfer).rejects.toMatchObject({
      errors: expect.arrayContaining([
        primary,
        expect.objectContaining({ message: expect.stringMatching(/exit 9/i) })
      ])
    })
    expect(fixture.commands.at(-1)).toBe("rm -rf '/private/content'")
  })

  it('bounds an unresponsive owned-root cleanup after cancellation', async () => {
    vi.useFakeTimers()
    const tree = await treeFixture()
    const fixture = createConnection({ writeError: new Error('write failed'), hangCleanup: true })
    const transfer = transferSshRelayRuntimeTreeViaPosixSystemSsh({
      tree,
      connection: fixture.connection,
      remoteStagingRoot: '/stage/content',
      signal: new AbortController().signal
    })
    const rejection = expect(transfer).rejects.toThrow(/cleanup|settlement timed out/i)

    await vi.waitFor(() => expect(fixture.commands.at(-1)).toBe("rm -rf '/stage/content'"))
    await vi.advanceTimersByTimeAsync(
      SSH_RELAY_RUNTIME_POSIX_TREE_TRANSFER_LIMITS.cleanupTimeoutMs + 2_000
    )
    await rejection
  })
})
