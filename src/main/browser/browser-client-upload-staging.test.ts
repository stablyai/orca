import { existsSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BROWSER_CLIENT_UPLOAD_STAGING_MAX_BYTES_PER_PAGE,
  BROWSER_CLIENT_UPLOAD_STAGING_MAX_COMMANDS_PER_PAGE,
  BrowserClientUploadStaging
} from './browser-client-upload-staging'

const nodeRemovals = vi.hoisted(() => ({ rm: [] as { target: unknown; options: unknown }[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    rm: (target: unknown, options: unknown) => {
      nodeRemovals.rm.push({ target, options })
      return (actual.rm as (t: unknown, o: unknown) => Promise<void>)(target, options)
    }
  }
})

let stagingRoot = ''

beforeEach(async () => {
  // Why: macOS reports /private/var for a /var mkdtemp path, so compare against the resolved root.
  stagingRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-upload-staging-')))
})

afterEach(async () => {
  await rm(stagingRoot, { recursive: true, force: true })
})

/** Release reports every failed removal together, so assert on the aggregate's contents. */
async function releaseFailures(release: Promise<unknown>): Promise<string[]> {
  const failure = await release.catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  return (failure as AggregateError).errors.map((error: Error) => error.message)
}

describe('BrowserClientUploadStaging', () => {
  it('writes remote bytes under main-owned directories and keeps the remote basename', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)

    const staged = await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 3,
      files: [
        { remotePath: 'docs/report.pdf', contents: Buffer.from('one') },
        { remotePath: 'notes.txt', contents: Buffer.from('two') }
      ]
    })

    expect(staged.localFilePaths.map((file) => path.basename(file))).toEqual([
      'report.pdf',
      'notes.txt'
    ])
    for (const file of staged.localFilePaths) {
      expect(await realpath(file)).toContain(stagingRoot)
    }
    expect(await readFile(staged.localFilePaths[0], 'utf8')).toBe('one')
    expect(await readFile(staged.localFilePaths[1], 'utf8')).toBe('two')
  })

  it('never lets a remote path escape the staging root', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)

    const staged = await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 1,
      files: [{ remotePath: '../../../etc/passwd', contents: Buffer.from('x') }]
    })

    expect(path.basename(staged.localFilePaths[0])).toBe('passwd')
    expect(path.resolve(staged.localFilePaths[0]).startsWith(stagingRoot)).toBe(true)
  })

  it('removes the staged directory when the page is released', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)
    const staged = await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 4,
      files: [{ remotePath: 'a.txt', contents: Buffer.from('a') }]
    })

    expect(await staging.releasePage('page-2')).toBe(0)
    expect(await readdir(stagingRoot)).toHaveLength(1)

    expect(await staging.releasePage('page-1')).toBe(1)
    expect(await readdir(stagingRoot)).toHaveLength(0)
    expect(staging.stagedDirectory(staged.stagingId)).toBeUndefined()
  })

  it('releases only the matching page generation when one is named', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)
    await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 1,
      files: [{ remotePath: 'a.txt', contents: Buffer.from('a') }]
    })
    await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 2,
      files: [{ remotePath: 'b.txt', contents: Buffer.from('b') }]
    })

    expect(await staging.releasePage('page-1', 1)).toBe(1)
    expect(staging.activeStagingCount()).toBe(1)
  })

  it('evicts a page oldest-first once its staged bytes exceed the budget', async () => {
    const removed: string[] = []
    const staging = new BrowserClientUploadStaging(stagingRoot, {
      mkdir: async () => {},
      writeFile: async () => {},
      removeDirectorySync: () => {},
      removeDirectory: async (directory) => {
        removed.push(directory)
      }
    })
    const half = BROWSER_CLIENT_UPLOAD_STAGING_MAX_BYTES_PER_PAGE / 2
    const first = await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 1,
      files: [{ remotePath: 'a.bin', contents: Buffer.alloc(half) }]
    })
    const firstDirectory = staging.stagedDirectory(first.stagingId)
    await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 1,
      files: [{ remotePath: 'b.bin', contents: Buffer.alloc(half) }]
    })
    expect(staging.activeStagingCount()).toBe(2)

    await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 1,
      files: [{ remotePath: 'c.bin', contents: Buffer.alloc(1) }]
    })

    expect(staging.activeStagingCount()).toBe(2)
    expect(removed).toEqual([firstDirectory])
  })

  it("leaves another page's staged copies alone when one page overflows", async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)
    await staging.stage({
      browserPageId: 'page-2',
      pageHostGeneration: 1,
      files: [{ remotePath: 'keep.txt', contents: Buffer.from('keep') }]
    })
    for (let index = 0; index <= BROWSER_CLIENT_UPLOAD_STAGING_MAX_COMMANDS_PER_PAGE; index += 1) {
      await staging.stage({
        browserPageId: 'page-1',
        pageHostGeneration: 1,
        files: [{ remotePath: `${index}.txt`, contents: Buffer.from('x') }]
      })
    }

    expect(staging.activeStagingCount()).toBe(
      BROWSER_CLIENT_UPLOAD_STAGING_MAX_COMMANDS_PER_PAGE + 1
    )
    expect(await staging.releasePage('page-2')).toBe(1)
  })

  it('cleans up the partial directory when a write fails', async () => {
    let writes = 0
    const staging = new BrowserClientUploadStaging(stagingRoot, {
      mkdir: async () => {},
      writeFile: async () => {
        writes += 1
        throw new Error('disk full')
      },
      removeDirectorySync: () => {},
      removeDirectory: async () => {}
    })

    await expect(
      staging.stage({
        browserPageId: 'page-1',
        pageHostGeneration: 1,
        files: [{ remotePath: 'a.txt', contents: Buffer.from('a') }]
      })
    ).rejects.toThrow('disk full')
    expect(writes).toBe(1)
    expect(staging.activeStagingCount()).toBe(0)
  })

  it('rejects an oversized or over-counted staging request before touching disk', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)

    await expect(
      staging.stage({
        browserPageId: 'page-1',
        pageHostGeneration: 1,
        files: Array.from({ length: 17 }, (_unused, index) => ({
          remotePath: `${index}.txt`,
          contents: Buffer.alloc(1)
        }))
      })
    ).rejects.toThrow('browser_client_upload_file_count_exceeded')

    await expect(
      staging.stage({
        browserPageId: 'page-1',
        pageHostGeneration: 1,
        files: [{ remotePath: 'big.bin', contents: Buffer.alloc(64 * 1024 * 1024 + 1) }]
      })
    ).rejects.toThrow('browser_client_upload_too_large')

    expect(staging.activeStagingCount()).toBe(0)
    expect(existsSync(stagingRoot)).toBe(false)
  })

  it('sweeps staged bytes an abnormal exit left in the root', async () => {
    const orphan = path.join(stagingRoot, 'abandoned', '0')
    await mkdir(orphan, { recursive: true })
    await writeFile(path.join(orphan, 'report.pdf'), 'remote-bytes')

    new BrowserClientUploadStaging(stagingRoot)

    expect(existsSync(path.join(stagingRoot, 'abandoned'))).toBe(false)
  })

  it('keeps the staged record when its removal fails so a later release retries it', async () => {
    const attempts: string[] = []
    const staging = new BrowserClientUploadStaging(stagingRoot, {
      mkdir: async () => {},
      writeFile: async () => {},
      removeDirectorySync: () => {},
      removeDirectory: async (directory) => {
        attempts.push(directory)
        if (attempts.length === 1) {
          throw new Error('EBUSY: resource busy or locked')
        }
      }
    })
    const staged = await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 1,
      files: [{ remotePath: 'a.txt', contents: Buffer.from('a') }]
    })
    const directory = staging.stagedDirectory(staged.stagingId)

    expect(await releaseFailures(staging.releasePage('page-1'))).toEqual([
      expect.stringContaining('EBUSY')
    ])
    expect(staging.activeStagingCount()).toBe(1)

    expect(await staging.releasePage('page-1')).toBe(1)
    expect(staging.activeStagingCount()).toBe(0)
    expect(attempts).toEqual([directory, directory])
  })

  it('attempts every staged record even when one removal fails', async () => {
    const attempts: string[] = []
    const staging = new BrowserClientUploadStaging(stagingRoot, {
      mkdir: async () => {},
      writeFile: async () => {},
      removeDirectorySync: () => {},
      removeDirectory: async (directory) => {
        attempts.push(directory)
        if (attempts.length === 1) {
          throw new Error('EBUSY: resource busy or locked')
        }
      }
    })
    const first = await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 1,
      files: [{ remotePath: 'a.txt', contents: Buffer.from('a') }]
    })
    const second = await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 1,
      files: [{ remotePath: 'b.txt', contents: Buffer.from('b') }]
    })
    const directories = [first, second].map((staged) => staging.stagedDirectory(staged.stagingId))

    expect(await releaseFailures(staging.releasePage('page-1'))).toHaveLength(1)

    expect(attempts).toEqual(directories)
    expect(staging.activeStagingCount()).toBe(1)
  })

  it('reports the staging failure, not the cleanup failure, when both fail', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot, {
      mkdir: async () => {},
      writeFile: async () => {
        throw new Error('disk full')
      },
      removeDirectorySync: () => {},
      removeDirectory: async () => {
        throw new Error('EBUSY: resource busy or locked')
      }
    })

    await expect(
      staging.stage({
        browserPageId: 'page-1',
        pageHostGeneration: 1,
        files: [{ remotePath: 'a.txt', contents: Buffer.from('a') }]
      })
    ).rejects.toThrow('disk full')
    // Why: the retained record is the only handle a later release has on the orphaned directory.
    expect(staging.activeStagingCount()).toBe(1)
  })

  it('retries the staged removal so a briefly held file is not orphaned', async () => {
    const staging = new BrowserClientUploadStaging(stagingRoot)
    const staged = await staging.stage({
      browserPageId: 'page-1',
      pageHostGeneration: 1,
      files: [{ remotePath: 'a.txt', contents: Buffer.from('a') }]
    })
    const directory = staging.stagedDirectory(staged.stagingId)
    nodeRemovals.rm.length = 0

    expect(await staging.release(staged.stagingId)).toBe(true)

    expect(nodeRemovals.rm).toEqual([
      {
        target: directory,
        options: { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }
      }
    ])
  })
})
