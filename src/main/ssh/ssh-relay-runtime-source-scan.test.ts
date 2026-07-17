import { execFile } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { publishSshRelayArtifactCacheEntry } from './ssh-relay-artifact-cache-entry'
import { createSshRelayArtifactCacheEntryFixture } from './ssh-relay-artifact-cache-entry-fixture'
import {
  acquireSshRelayArtifactCacheInUseLease,
  type SshRelayArtifactCacheInUseLease
} from './ssh-relay-artifact-cache-in-use-lease'
import { createSshRelayRuntimeSourceTree } from './ssh-relay-runtime-source-tree'
import {
  scanSshRelayRuntimeSourceTree,
  type SshRelayRuntimeSourceScanOperations
} from './ssh-relay-runtime-source-scan'

const execFileAsync = promisify(execFile)
const cleanupRoots = new Set<string>()
const cleanupLeases = new Set<SshRelayArtifactCacheInUseLease>()

async function sourceFixture(os: 'linux' | 'win32' = 'linux') {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-source-scan-'))
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
  const tree = createSshRelayRuntimeSourceTree({
    kind: 'ready',
    source: 'cache',
    artifact: fixture.artifact,
    entry,
    lease
  })
  return { root, tree }
}

afterEach(async () => {
  await Promise.all([...cleanupLeases].map((lease) => lease.release().catch(() => {})))
  cleanupLeases.clear()
  await Promise.all([...cleanupRoots].map((root) => rm(root, { recursive: true, force: true })))
  cleanupRoots.clear()
})

describe('SSH relay runtime source pre-scan', () => {
  it.each(['linux', 'win32'] as const)(
    'authenticates and freezes a complete signed %s cache tree',
    async (os) => {
      const { tree } = await sourceFixture(os)

      const scanned = await scanSshRelayRuntimeSourceTree(tree, new AbortController().signal)

      expect(scanned).toMatchObject({
        tupleId: tree.tupleId,
        contentId: tree.contentId,
        runtimeRoot: tree.runtimeRoot,
        fileCount: tree.fileCount,
        expandedBytes: tree.expandedBytes
      })
      expect(scanned.directories.map((entry) => entry.path)).toEqual(
        tree.directories.map((entry) => entry.path)
      )
      expect(scanned.files.map((entry) => entry.path)).toEqual(
        tree.files.map((entry) => entry.path)
      )
      expect(Object.isFrozen(scanned)).toBe(true)
      expect(Object.isFrozen(scanned.runtimeRootState)).toBe(true)
      expect(scanned.directories.every((entry) => Object.isFrozen(entry.state))).toBe(true)
      expect(scanned.files.every((entry) => Object.isFrozen(entry.state))).toBe(true)
      expect(typeof scanned.files[0].state.mtimeNs).toBe('bigint')
    }
  )

  it('asserts the borrowed lease before and after the complete scan without releasing it', async () => {
    const { tree } = await sourceFixture()
    const assertLeaseOwned = vi.fn(tree.assertLeaseOwned)

    await scanSshRelayRuntimeSourceTree({ ...tree, assertLeaseOwned }, new AbortController().signal)

    expect(assertLeaseOwned).toHaveBeenCalledTimes(2)
  })

  it('settles pre-cancellation before lease or filesystem work', async () => {
    const { tree } = await sourceFixture()
    const assertLeaseOwned = vi.fn(tree.assertLeaseOwned)
    const controller = new AbortController()
    controller.abort(new Error('cancel source scan'))

    await expect(
      scanSshRelayRuntimeSourceTree({ ...tree, assertLeaseOwned }, controller.signal)
    ).rejects.toThrow(/cancel source scan/i)
    expect(assertLeaseOwned).not.toHaveBeenCalled()
  })

  it.each([
    [
      'extra file',
      async (tree: Awaited<ReturnType<typeof sourceFixture>>['tree']) => {
        await writeFile(join(tree.runtimeRoot, 'extra.bin'), 'extra')
      }
    ],
    [
      'missing file',
      async (tree: Awaited<ReturnType<typeof sourceFixture>>['tree']) => {
        await rm(tree.files[0].localPath)
      }
    ],
    [
      'same-size hash drift',
      async (tree: Awaited<ReturnType<typeof sourceFixture>>['tree']) => {
        const bytes = await readFile(tree.files[0].localPath)
        bytes[0] ^= 0xff
        await writeFile(tree.files[0].localPath, bytes)
      }
    ]
  ] as const)('rejects %s before returning a snapshot', async (_name, mutate) => {
    const { tree } = await sourceFixture()
    await mutate(tree)

    await expect(scanSshRelayRuntimeSourceTree(tree, new AbortController().signal)).rejects.toThrow(
      /extra|undeclared|missing|integrity|hash/i
    )
  })

  it('rejects a linked directory before following it', async () => {
    const { root, tree } = await sourceFixture()
    const bin = join(tree.runtimeRoot, 'bin')
    const external = join(root, 'external-bin')
    await rm(bin, { recursive: true })
    await mkdir(external)
    await symlink(external, bin, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(scanSshRelayRuntimeSourceTree(tree, new AbortController().signal)).rejects.toThrow(
      /link|type|directory/i
    )
  })

  it.skipIf(process.platform === 'win32')('rejects a special file', async () => {
    const { tree } = await sourceFixture()
    await rm(tree.files[0].localPath)
    await execFileAsync('mkfifo', [tree.files[0].localPath])

    await expect(scanSshRelayRuntimeSourceTree(tree, new AbortController().signal)).rejects.toThrow(
      /special|type|regular/i
    )
  })

  it.skipIf(process.platform !== 'linux')('rejects case-fold collisions', async () => {
    const { tree } = await sourceFixture()
    await writeFile(join(tree.runtimeRoot, 'RELAY.JS'), 'collision')

    await expect(scanSshRelayRuntimeSourceTree(tree, new AbortController().signal)).rejects.toThrow(
      /collision/i
    )
  })

  it('classifies a case-fold variant before its signed peer is enumerated', async () => {
    const { tree } = await sourceFixture()
    const close = vi.fn(async () => {})
    const scanLstat = vi.fn((path: string) => lstat(path, { bigint: true }))
    let returnedVariant = false
    const operations: Partial<SshRelayRuntimeSourceScanOperations> = {
      lstat: scanLstat,
      openDirectory: async () => ({
        read: async () => {
          if (returnedVariant) {
            return null
          }
          returnedVariant = true
          return { name: 'RELAY.JS' }
        },
        close
      })
    }

    await expect(
      scanSshRelayRuntimeSourceTree(tree, new AbortController().signal, operations)
    ).rejects.toThrow(/collision/i)
    expect(scanLstat).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')('rejects executable mode drift', async () => {
    const { tree } = await sourceFixture()
    const executable = tree.files.find((file) => file.mode === 0o755)!
    await chmod(executable.localPath, 0o644)

    await expect(scanSshRelayRuntimeSourceTree(tree, new AbortController().signal)).rejects.toThrow(
      /mode/i
    )
  })

  it('closes an open file and propagates mid-read cancellation', async () => {
    const { tree } = await sourceFixture()
    const controller = new AbortController()
    const close = vi.fn(async () => {})
    const operations: Partial<SshRelayRuntimeSourceScanOperations> = {
      openFile: async (path) => {
        const handle = await open(path, 'r')
        return {
          stat: () => handle.stat({ bigint: true }),
          read: async (...args) => {
            const result = await handle.read(...args)
            controller.abort(new Error('cancel during source read'))
            return result
          },
          close: async () => {
            await handle.close()
            await close()
          }
        }
      }
    }

    await expect(
      scanSshRelayRuntimeSourceTree(tree, controller.signal, operations)
    ).rejects.toThrow(/cancel during source read/i)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes an open directory and propagates mid-enumeration cancellation', async () => {
    const { tree } = await sourceFixture()
    const controller = new AbortController()
    const close = vi.fn(async () => {})
    const scanLstat = vi.fn((path: string) => lstat(path, { bigint: true }))
    const operations: Partial<SshRelayRuntimeSourceScanOperations> = {
      lstat: scanLstat,
      openDirectory: async (path) => {
        const handle = await opendir(path)
        return {
          read: async () => {
            const entry = await handle.read()
            controller.abort(new Error('cancel during source enumeration'))
            return entry
          },
          close: async () => {
            await handle.close()
            await close()
          }
        }
      }
    }

    await expect(
      scanSshRelayRuntimeSourceTree(tree, controller.signal, operations)
    ).rejects.toThrow(/cancel during source enumeration/i)
    expect(close).toHaveBeenCalledTimes(1)
    expect(scanLstat).toHaveBeenCalledTimes(1)
  })

  it.each(['directory', 'file'] as const)('propagates an open %s close failure', async (kind) => {
    const { tree } = await sourceFixture()
    const operations: Partial<SshRelayRuntimeSourceScanOperations> =
      kind === 'directory'
        ? {
            openDirectory: async (path) => {
              const handle = await opendir(path)
              return {
                read: () => handle.read(),
                close: async () => {
                  await handle.close()
                  throw new Error('source directory close failed')
                }
              }
            }
          }
        : {
            openFile: async (path) => {
              const handle = await open(path, 'r')
              return {
                stat: () => handle.stat({ bigint: true }),
                read: (buffer, offset, length, position) =>
                  handle.read(buffer, offset, length, position),
                close: async () => {
                  await handle.close()
                  throw new Error('source file close failed')
                }
              }
            }
          }

    await expect(
      scanSshRelayRuntimeSourceTree(tree, new AbortController().signal, operations)
    ).rejects.toThrow(new RegExp(`source ${kind} close failed`, 'i'))
  })

  it('never keeps more than one directory or file handle open', async () => {
    const { tree } = await sourceFixture()
    let openDirectories = 0
    let openFiles = 0
    let peakDirectories = 0
    let peakFiles = 0
    const operations: Partial<SshRelayRuntimeSourceScanOperations> = {
      openDirectory: async (path) => {
        const handle = await opendir(path)
        openDirectories += 1
        peakDirectories = Math.max(peakDirectories, openDirectories)
        return {
          read: () => handle.read(),
          close: async () => {
            await handle.close()
            openDirectories -= 1
          }
        }
      },
      openFile: async (path) => {
        const handle = await open(path, 'r')
        openFiles += 1
        peakFiles = Math.max(peakFiles, openFiles)
        return {
          stat: () => handle.stat({ bigint: true }),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            await handle.close()
            openFiles -= 1
          }
        }
      }
    }

    await scanSshRelayRuntimeSourceTree(tree, new AbortController().signal, operations)

    expect({ openDirectories, openFiles, peakDirectories, peakFiles }).toEqual({
      openDirectories: 0,
      openFiles: 0,
      peakDirectories: 1,
      peakFiles: 1
    })
  })

  it('uses at most one 64 KiB read buffer and rejects a mutation after hashing', async () => {
    const { tree } = await sourceFixture()
    const readLengths: number[] = []
    let mutated = false
    const operations: Partial<SshRelayRuntimeSourceScanOperations> = {
      openFile: async (path) => {
        const handle = await open(path, 'r')
        return {
          stat: () => handle.stat({ bigint: true }),
          read: async (buffer, offset, length, position) => {
            readLengths.push(length)
            return handle.read(buffer, offset, length, position)
          },
          close: async () => {
            await handle.close()
            if (!mutated) {
              mutated = true
              const bytes = await readFile(path)
              bytes[0] ^= 0xff
              await writeFile(path, bytes)
            }
          }
        }
      }
    }

    await expect(
      scanSshRelayRuntimeSourceTree(tree, new AbortController().signal, operations)
    ).rejects.toThrow(/changed|mutation|state/i)
    expect(Math.max(...readLengths)).toBeLessThanOrEqual(64 * 1024)
  })
})
