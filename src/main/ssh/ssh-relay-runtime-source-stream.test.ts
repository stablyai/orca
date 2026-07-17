import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { publishSshRelayArtifactCacheEntry } from './ssh-relay-artifact-cache-entry'
import { createSshRelayArtifactCacheEntryFixture } from './ssh-relay-artifact-cache-entry-fixture'
import {
  acquireSshRelayArtifactCacheInUseLease,
  type SshRelayArtifactCacheInUseLease
} from './ssh-relay-artifact-cache-in-use-lease'
import { scanSshRelayRuntimeSourceTree } from './ssh-relay-runtime-source-scan'
import type { SshRelayRuntimeSourceMetadata } from './ssh-relay-runtime-source-snapshot'
import {
  streamSshRelayRuntimeSourceTree,
  type SshRelayRuntimeSourceDestination,
  type SshRelayRuntimeSourceStreamOperations,
  type SshRelayRuntimeSourceStreamProgress
} from './ssh-relay-runtime-source-stream'
import { createSshRelayRuntimeSourceTree } from './ssh-relay-runtime-source-tree'

const cleanupRoots = new Set<string>()
const cleanupLeases = new Set<SshRelayArtifactCacheInUseLease>()

async function sourceStreamFixture({
  os = 'linux',
  fileBytes
}: {
  os?: 'linux' | 'win32'
  fileBytes?: ReadonlyMap<string, Buffer>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-source-stream-'))
  cleanupRoots.add(root)
  const inputRoot = join(root, 'input')
  await mkdir(inputRoot)
  const fixture = await createSshRelayArtifactCacheEntryFixture({
    root: inputRoot,
    os,
    fileBytes
  })
  const cacheRoot = join(root, 'cache')
  const entry = await publishSshRelayArtifactCacheEntry({
    cacheRoot,
    artifact: fixture.artifact,
    archivePath: fixture.archivePath
  })
  const lease = await acquireSshRelayArtifactCacheInUseLease({ cacheRoot, entry })
  cleanupLeases.add(lease)
  const sourceTree = createSshRelayRuntimeSourceTree({
    kind: 'ready',
    source: 'cache',
    artifact: fixture.artifact,
    entry,
    lease
  })
  const tree = await scanSshRelayRuntimeSourceTree(sourceTree, new AbortController().signal)
  return { root, tree }
}

function digestDestination(
  digests: Map<string, string>,
  events: string[] = []
): (file: { path: string }) => Promise<SshRelayRuntimeSourceDestination> {
  return async (file) => {
    events.push(`open:${file.path}`)
    const digest = createHash('sha256')
    return {
      write: async (chunk) => {
        events.push(`write:${file.path}:${chunk.length}`)
        digest.update(chunk)
      },
      close: async () => {
        events.push(`close:${file.path}`)
        digests.set(file.path, `sha256:${digest.digest('hex')}`)
      },
      abort: async () => {
        events.push(`abort:${file.path}`)
      }
    }
  }
}

afterEach(async () => {
  await Promise.all([...cleanupLeases].map((lease) => lease.release().catch(() => {})))
  cleanupLeases.clear()
  await Promise.all([...cleanupRoots].map((root) => rm(root, { recursive: true, force: true })))
  cleanupRoots.clear()
})

describe('SSH relay runtime bounded source stream', () => {
  it.each(['linux', 'win32'] as const)(
    'streams the complete signed %s tree with frozen path-free progress',
    async (os) => {
      const { tree } = await sourceStreamFixture({ os })
      const digests = new Map<string, string>()
      const progress: SshRelayRuntimeSourceStreamProgress[] = []

      const result = await streamSshRelayRuntimeSourceTree({
        tree,
        signal: new AbortController().signal,
        maximumConcurrency: 2,
        openDestination: digestDestination(digests),
        onProgress: (value) => progress.push(value)
      })

      expect(result).toEqual({
        tupleId: tree.tupleId,
        contentId: tree.contentId,
        filesCompleted: tree.fileCount,
        totalFiles: tree.fileCount,
        bytesTransferred: tree.expandedBytes,
        totalBytes: tree.expandedBytes
      })
      expect(Object.isFrozen(result)).toBe(true)
      expect(digests).toEqual(new Map(tree.files.map((file) => [file.path, file.sha256])))
      expect(progress.length).toBeGreaterThan(tree.fileCount)
      expect(progress.every(Object.isFrozen)).toBe(true)
      expect(progress.at(-1)).toMatchObject(result)
      expect(progress.map((value) => value.bytesTransferred)).toEqual(
        progress.map((value) => value.bytesTransferred).sort((left, right) => left - right)
      )
      const progressJson = JSON.stringify(progress)
      expect(progressJson).not.toContain(tree.runtimeRoot)
      expect(tree.files.every((file) => !progressJson.includes(file.path))).toBe(true)
    }
  )

  it('bounds zero-byte and multi-chunk files to one 64 KiB buffer per worker', async () => {
    const largeBytes = Buffer.alloc(2 * 64 * 1024 + 17, 0xa5)
    const { tree } = await sourceStreamFixture({
      fileBytes: new Map([
        ['relay.js', largeBytes],
        ['THIRD_PARTY_LICENSES.txt', Buffer.alloc(0)]
      ])
    })
    const writeLengths = new Map<string, number[]>()
    const closed: string[] = []

    await streamSshRelayRuntimeSourceTree({
      tree,
      signal: new AbortController().signal,
      maximumConcurrency: 1,
      openDestination: async (file) => ({
        write: async (chunk) => {
          const lengths = writeLengths.get(file.path) ?? []
          lengths.push(chunk.length)
          writeLengths.set(file.path, lengths)
        },
        close: async () => {
          closed.push(file.path)
        },
        abort: async () => {}
      })
    })

    expect(writeLengths.get('relay.js')).toEqual([64 * 1024, 64 * 1024, 17])
    expect(writeLengths.get('THIRD_PARTY_LICENSES.txt')).toBeUndefined()
    expect(closed).toContain('THIRD_PARTY_LICENSES.txt')
  })

  it('never opens more than four local files or destinations', async () => {
    const { tree } = await sourceStreamFixture()
    let openFiles = 0
    let openDestinations = 0
    let peakFiles = 0
    let peakDestinations = 0
    let releaseWrites: (() => void) | undefined
    const writeGate = new Promise<void>((resolve) => {
      releaseWrites = resolve
    })
    const operations: Partial<SshRelayRuntimeSourceStreamOperations> = {
      openFile: async (path) => {
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
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

    const transfer = streamSshRelayRuntimeSourceTree(
      {
        tree,
        signal: new AbortController().signal,
        maximumConcurrency: 4,
        openDestination: async () => {
          openDestinations += 1
          peakDestinations = Math.max(peakDestinations, openDestinations)
          if (openDestinations === 4) {
            releaseWrites?.()
          }
          return {
            write: async () => writeGate,
            close: async () => {
              openDestinations -= 1
            },
            abort: async () => {
              openDestinations -= 1
            }
          }
        }
      },
      operations
    )

    await transfer
    expect({ openFiles, openDestinations, peakFiles, peakDestinations }).toEqual({
      openFiles: 0,
      openDestinations: 0,
      peakFiles: 4,
      peakDestinations: 4
    })
  })

  it.each([0, 5, 1.5])(
    'rejects invalid concurrency %s before lease or filesystem work',
    async (value) => {
      const { tree } = await sourceStreamFixture()
      const assertLeaseOwned = vi.fn(tree.assertLeaseOwned)
      const openDestination = vi.fn()

      await expect(
        streamSshRelayRuntimeSourceTree({
          tree: { ...tree, assertLeaseOwned },
          signal: new AbortController().signal,
          maximumConcurrency: value,
          openDestination
        })
      ).rejects.toThrow(/concurrency/i)
      expect(assertLeaseOwned).not.toHaveBeenCalled()
      expect(openDestination).not.toHaveBeenCalled()
    }
  )

  it('settles pre-cancellation before lease, filesystem, or destination work', async () => {
    const { tree } = await sourceStreamFixture()
    const assertLeaseOwned = vi.fn(tree.assertLeaseOwned)
    const openDestination = vi.fn()
    const controller = new AbortController()
    controller.abort(new Error('cancel source stream'))

    await expect(
      streamSshRelayRuntimeSourceTree({
        tree: { ...tree, assertLeaseOwned },
        signal: controller.signal,
        openDestination
      })
    ).rejects.toThrow(/cancel source stream/i)
    expect(assertLeaseOwned).not.toHaveBeenCalled()
    expect(openDestination).not.toHaveBeenCalled()
  })

  it('opens a destination only after exact path and handle checks', async () => {
    const { tree } = await sourceStreamFixture()
    const events: string[] = []
    const operations: Partial<SshRelayRuntimeSourceStreamOperations> = {
      lstat: async (path) => {
        events.push(`lstat:${path}`)
        return lstat(path, { bigint: true })
      },
      openFile: async (path) => {
        events.push(`open-file:${path}`)
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        return {
          stat: async () => {
            events.push(`handle-stat:${path}`)
            return handle.stat({ bigint: true })
          },
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: () => handle.close()
        }
      }
    }

    await streamSshRelayRuntimeSourceTree(
      {
        tree,
        signal: new AbortController().signal,
        maximumConcurrency: 1,
        openDestination: async (file) => {
          events.push(`open-destination:${file.path}`)
          return { write: async () => {}, close: async () => {}, abort: async () => {} }
        }
      },
      operations
    )

    const firstDestination = events.findIndex((event) => event.startsWith('open-destination:'))
    const beforeFirstDestination = events.slice(0, firstDestination)
    for (const path of [
      tree.runtimeRoot,
      ...tree.directories.map((directory) => directory.localPath),
      ...tree.files.map((file) => file.localPath)
    ]) {
      expect(beforeFirstDestination).toContain(`lstat:${path}`)
    }
    expect(beforeFirstDestination).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^open-file:/),
        expect.stringMatching(/^handle-stat:/)
      ])
    )
  })

  it.each<
    readonly [string, (metadata: SshRelayRuntimeSourceMetadata) => SshRelayRuntimeSourceMetadata]
  >([
    [
      'linked',
      (metadata) => Object.assign(Object.create(metadata), { isSymbolicLink: () => true })
    ],
    ['wrong type', (metadata) => Object.assign(Object.create(metadata), { isFile: () => false })],
    [
      'state drift',
      (metadata) => Object.assign(Object.create(metadata), { mtimeNs: metadata.mtimeNs + 1n })
    ]
  ])('rejects %s source metadata before destination creation', async (_label, mutate) => {
    const { tree } = await sourceStreamFixture()
    const target = tree.files[0].localPath
    const openDestination = vi.fn()
    await expect(
      streamSshRelayRuntimeSourceTree(
        { tree, signal: new AbortController().signal, openDestination },
        {
          lstat: async (path) => {
            const metadata = (await lstat(path, {
              bigint: true
            })) as SshRelayRuntimeSourceMetadata
            return path === target ? mutate(metadata) : metadata
          }
        }
      )
    ).rejects.toThrow(/changed|mode/i)
    expect(openDestination).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'rejects POSIX mode metadata before destination creation',
    async () => {
      const { tree } = await sourceStreamFixture()
      const target = tree.files[0].localPath
      const openDestination = vi.fn()
      await expect(
        streamSshRelayRuntimeSourceTree(
          { tree, signal: new AbortController().signal, openDestination },
          {
            lstat: async (path) => {
              const metadata = (await lstat(path, {
                bigint: true
              })) as SshRelayRuntimeSourceMetadata
              return path === target
                ? Object.assign(Object.create(metadata), { mode: metadata.mode ^ 1n })
                : metadata
            }
          }
        )
      ).rejects.toThrow(/mode/i)
      expect(openDestination).not.toHaveBeenCalled()
    }
  )

  it('rejects source mutation before destination creation', async () => {
    const { tree } = await sourceStreamFixture()
    const openDestination = vi.fn()
    const bytes = await readFile(tree.files[0].localPath)
    bytes[0] ^= 0xff
    await writeFile(tree.files[0].localPath, bytes)

    await expect(
      streamSshRelayRuntimeSourceTree({
        tree,
        signal: new AbortController().signal,
        openDestination
      })
    ).rejects.toThrow(/changed|mutation|state/i)
    expect(openDestination).not.toHaveBeenCalled()
  })

  it('closes over a local-open failure without creating a destination', async () => {
    const { tree } = await sourceStreamFixture()
    const openDestination = vi.fn()
    await expect(
      streamSshRelayRuntimeSourceTree(
        { tree, signal: new AbortController().signal, openDestination },
        {
          openFile: async () => {
            throw new Error('local open failure')
          }
        }
      )
    ).rejects.toThrow(/local open failure/i)
    expect(openDestination).not.toHaveBeenCalled()
  })

  it('aborts when bytes returned by the local reader fail the signed digest', async () => {
    const { tree } = await sourceStreamFixture()
    const abort = vi.fn(async () => {})
    const operations: Partial<SshRelayRuntimeSourceStreamOperations> = {
      openFile: async (path) => {
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        return {
          stat: () => handle.stat({ bigint: true }),
          read: async (buffer, offset, length, position) => {
            const result = await handle.read(buffer, offset, length, position)
            if (result.bytesRead > 0) {
              buffer[offset] ^= 0xff
            }
            return result
          },
          close: () => handle.close()
        }
      }
    }

    await expect(
      streamSshRelayRuntimeSourceTree(
        {
          tree,
          signal: new AbortController().signal,
          openDestination: async () => ({ write: async () => {}, close: async () => {}, abort })
        },
        operations
      )
    ).rejects.toThrow(/integrity changed/i)
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('aborts instead of finalizing when the source mutates during a write', async () => {
    const { tree } = await sourceStreamFixture()
    const close = vi.fn(async () => {})
    const abort = vi.fn(async () => {})
    let mutated = false

    await expect(
      streamSshRelayRuntimeSourceTree({
        tree,
        signal: new AbortController().signal,
        maximumConcurrency: 1,
        openDestination: async (file) => ({
          write: async () => {
            if (!mutated) {
              mutated = true
              const bytes = await readFile(file.localPath)
              bytes[0] ^= 0xff
              await writeFile(file.localPath, bytes)
            }
          },
          close,
          abort
        })
      })
    ).rejects.toThrow(/changed|mutation|state/i)
    expect(close).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('closes the local file and aborts once on destination write failure', async () => {
    const { tree } = await sourceStreamFixture()
    const localClose = vi.fn(async () => {})
    const abort = vi.fn(async () => {})
    const operations: Partial<SshRelayRuntimeSourceStreamOperations> = {
      openFile: async (path) => {
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        return {
          stat: () => handle.stat({ bigint: true }),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            await handle.close()
            await localClose()
          }
        }
      }
    }

    await expect(
      streamSshRelayRuntimeSourceTree(
        {
          tree,
          signal: new AbortController().signal,
          maximumConcurrency: 1,
          openDestination: async () => ({
            write: async () => {
              throw new Error('destination write failed')
            },
            close: async () => {},
            abort
          })
        },
        operations
      )
    ).rejects.toThrow(/destination write failed/i)
    expect(localClose).toHaveBeenCalledTimes(1)
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('propagates mid-write cancellation and performs no later writes', async () => {
    const { tree } = await sourceStreamFixture({
      fileBytes: new Map([['relay.js', Buffer.alloc(3 * 64 * 1024, 0x5a)]])
    })
    const controller = new AbortController()
    const write = vi.fn(async () => {
      controller.abort(new Error('cancel during destination write'))
    })
    const abort = vi.fn(async () => {})

    await expect(
      streamSshRelayRuntimeSourceTree({
        tree,
        signal: controller.signal,
        maximumConcurrency: 1,
        openDestination: async () => ({ write, close: async () => {}, abort })
      })
    ).rejects.toThrow(/cancel during destination write/i)
    expect(write).toHaveBeenCalledTimes(1)
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('settles mid-read cancellation before any destination write', async () => {
    const { tree } = await sourceStreamFixture()
    const controller = new AbortController()
    const write = vi.fn(async () => {})
    const abort = vi.fn(async () => {})
    const operations: Partial<SshRelayRuntimeSourceStreamOperations> = {
      openFile: async (path) => {
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        return {
          stat: () => handle.stat({ bigint: true }),
          read: async (buffer, offset, length, position) => {
            const result = await handle.read(buffer, offset, length, position)
            controller.abort(new Error('cancel during local read'))
            return result
          },
          close: () => handle.close()
        }
      }
    }

    await expect(
      streamSshRelayRuntimeSourceTree(
        {
          tree,
          signal: controller.signal,
          openDestination: async () => ({ write, close: async () => {}, abort })
        },
        operations
      )
    ).rejects.toThrow(/cancel during local read/i)
    expect(write).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('joins local read, local close, and destination abort failures', async () => {
    const { tree } = await sourceStreamFixture()
    const operations: Partial<SshRelayRuntimeSourceStreamOperations> = {
      openFile: async (path) => {
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        return {
          stat: () => handle.stat({ bigint: true }),
          read: async () => {
            throw new Error('local read failure')
          },
          close: async () => {
            await handle.close()
            throw new Error('local close failure')
          }
        }
      }
    }

    const error = await streamSshRelayRuntimeSourceTree(
      {
        tree,
        signal: new AbortController().signal,
        openDestination: async () => ({
          write: async () => {},
          close: async () => {},
          abort: async () => {
            throw new Error('destination abort failure')
          }
        })
      },
      operations
    ).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'local read failure' }),
      expect.objectContaining({ message: 'local close failure' }),
      expect.objectContaining({ message: 'destination abort failure' })
    ])
  })

  it('waits for every concurrent destination to settle before rejecting', async () => {
    const { tree } = await sourceStreamFixture()
    let releaseSecondWrite: (() => void) | undefined
    let markSecondWriteStarted: (() => void) | undefined
    let markFirstAbort: (() => void) | undefined
    const secondWriteGate = new Promise<void>((resolve) => {
      releaseSecondWrite = resolve
    })
    const secondWriteStarted = new Promise<void>((resolve) => {
      markSecondWriteStarted = resolve
    })
    const firstAborted = new Promise<void>((resolve) => {
      markFirstAbort = resolve
    })
    let settled = false
    const secondClose = vi.fn(async () => {})
    const secondAbort = vi.fn(async () => {})

    const transfer = streamSshRelayRuntimeSourceTree({
      tree,
      signal: new AbortController().signal,
      maximumConcurrency: 2,
      openDestination: async (file) => ({
        write:
          file === tree.files[0]
            ? async () => {
                await secondWriteStarted
                throw new Error('first concurrent write failed')
              }
            : async () => {
                markSecondWriteStarted?.()
                await secondWriteGate
              },
        close: file === tree.files[0] ? async () => {} : secondClose,
        abort: async () => {
          if (file === tree.files[0]) {
            markFirstAbort?.()
          } else {
            await secondAbort()
          }
        }
      })
    }).finally(() => {
      settled = true
    })

    await firstAborted
    expect(settled).toBe(false)
    releaseSecondWrite?.()
    await expect(transfer).rejects.toThrow(/first concurrent write failed/i)
    expect(settled).toBe(true)
    expect(secondClose).not.toHaveBeenCalled()
    expect(secondAbort).toHaveBeenCalledTimes(1)
  })

  it('joins a primary write failure with destination abort failure', async () => {
    const { tree } = await sourceStreamFixture()

    const error = await streamSshRelayRuntimeSourceTree({
      tree,
      signal: new AbortController().signal,
      maximumConcurrency: 1,
      openDestination: async () => ({
        write: async () => {
          throw new Error('primary write failure')
        },
        close: async () => {},
        abort: async () => {
          throw new Error('destination abort failure')
        }
      })
    }).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'primary write failure' }),
      expect.objectContaining({ message: 'destination abort failure' })
    ])
  })

  it('joins a destination-open failure with local-close failure', async () => {
    const { tree } = await sourceStreamFixture()
    const operations: Partial<SshRelayRuntimeSourceStreamOperations> = {
      openFile: async (path) => {
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        return {
          stat: () => handle.stat({ bigint: true }),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            await handle.close()
            throw new Error('local close failure')
          }
        }
      }
    }

    const error = await streamSshRelayRuntimeSourceTree(
      {
        tree,
        signal: new AbortController().signal,
        openDestination: async () => {
          throw new Error('destination open failure')
        }
      },
      operations
    ).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'destination open failure' }),
      expect.objectContaining({ message: 'local close failure' })
    ])
  })

  it('rejects incomplete and reused destinations without taking duplicate ownership', async () => {
    const { tree } = await sourceStreamFixture()
    await expect(
      streamSshRelayRuntimeSourceTree({
        tree,
        signal: new AbortController().signal,
        openDestination: async () => undefined as unknown as SshRelayRuntimeSourceDestination
      })
    ).rejects.toThrow(/destination is incomplete/i)

    const close = vi.fn(async () => {})
    const abort = vi.fn(async () => {})
    const destination = { write: async () => {}, close, abort }
    await expect(
      streamSshRelayRuntimeSourceTree({
        tree,
        signal: new AbortController().signal,
        maximumConcurrency: 1,
        openDestination: async () => destination
      })
    ).rejects.toThrow(/destination was reused/i)
    expect(close).toHaveBeenCalledTimes(1)
    expect(abort).not.toHaveBeenCalled()
  })

  it('aborts when destination close or the progress observer fails', async () => {
    const { tree } = await sourceStreamFixture()
    const closeAbort = vi.fn(async () => {})
    await expect(
      streamSshRelayRuntimeSourceTree({
        tree,
        signal: new AbortController().signal,
        maximumConcurrency: 1,
        openDestination: async () => ({
          write: async () => {},
          close: async () => {
            throw new Error('destination close failed')
          },
          abort: closeAbort
        })
      })
    ).rejects.toThrow(/destination close failed/i)
    expect(closeAbort).toHaveBeenCalledTimes(1)

    const progressAbort = vi.fn(async () => {})
    await expect(
      streamSshRelayRuntimeSourceTree({
        tree,
        signal: new AbortController().signal,
        maximumConcurrency: 1,
        openDestination: async () => ({
          write: async () => {},
          close: async () => {},
          abort: progressAbort
        }),
        onProgress: () => {
          throw new Error('progress observer failed')
        }
      })
    ).rejects.toThrow(/progress observer failed/i)
    expect(progressAbort).toHaveBeenCalledTimes(1)
  })

  it('asserts but never releases the borrowed lease before and after streaming', async () => {
    const { tree } = await sourceStreamFixture()
    const assertLeaseOwned = vi.fn(tree.assertLeaseOwned)

    await streamSshRelayRuntimeSourceTree({
      tree: { ...tree, assertLeaseOwned },
      signal: new AbortController().signal,
      openDestination: async () => ({
        write: async () => {},
        close: async () => {},
        abort: async () => {}
      })
    })

    expect(assertLeaseOwned).toHaveBeenCalledTimes(2)
  })
})
