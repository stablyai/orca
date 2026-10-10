import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'

const fsMocks = vi.hoisted(() => ({ readdir: vi.fn(), stat: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  readdir: fsMocks.readdir,
  stat: fsMocks.stat
}))

import { discoverFiles } from './session-scanner-discovery'

const fs = await vi.importActual<typeof FsPromises>('node:fs/promises')
let root: string

beforeEach(async () => {
  fsMocks.readdir.mockReset().mockImplementation(fs.readdir)
  fsMocks.stat.mockReset().mockImplementation(fs.stat)
  root = await fs.mkdtemp(join(tmpdir(), 'orca-fresh-discovery-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

async function createFiles(directory: string, count: number): Promise<string[]> {
  await fs.mkdir(directory, { recursive: true })
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      fs.writeFile(join(directory, `${index.toString().padStart(3, '0')}.jsonl`), '{}\n')
    )
  )
  return (await fs.readdir(directory)).map((name) => join(directory, name))
}

function scan(scanRoot = root, issues: AiVaultScanIssue[] = [], limit = 100) {
  return discoverFiles({
    rootDir: scanRoot,
    issues,
    limit,
    agent: 'claude',
    extensions: ['.jsonl']
  })
}

describe('fresh discovery pipeline', () => {
  it('formats timestamps only for retained files while still reading every candidate', async () => {
    await createFiles(root, 35)
    fsMocks.stat.mockImplementation(async (path: string) =>
      Object.assign(await fs.stat(path), { mtimeMs: 1_000 })
    )
    const format = vi.spyOn(Date.prototype, 'toISOString')
    expect((await scan(root, [], 3)).files).toHaveLength(3)
    expect(format).toHaveBeenCalledTimes(3)
    expect(fsMocks.stat).toHaveBeenCalledTimes(35)
    format.mockClear()
    expect((await scan(root, [], 0)).files).toEqual([])
    expect(format).not.toHaveBeenCalled()
    expect(fsMocks.stat).toHaveBeenCalledTimes(70)
    expect((await scan(root, [], Infinity)).files).toHaveLength(35)
    expect(format).toHaveBeenCalledTimes(35)
  })

  it('reports invalid timestamps even for empty requests, after unavailable sidecar issues', async () => {
    const [file] = await createFiles(root, 1)
    fsMocks.stat.mockImplementation(async (path: string) => {
      if (path.endsWith('.meta')) {
        throw Object.assign(new Error('metadata refused'), { code: 'EACCES' })
      }
      return Object.assign(await fs.stat(path), { mtimeMs: Infinity })
    })
    const issues: AiVaultScanIssue[] = []
    const discovery = await discoverFiles({
      rootDir: root,
      issues,
      limit: 0,
      agent: 'claude',
      extensions: ['.jsonl'],
      contentDependencyPath: (path) => `${path}.meta`
    })
    expect(discovery.files).toEqual([])
    expect(issues).toEqual([
      {
        agent: 'claude',
        path: `${file}.meta`,
        message: 'Session metadata could not be read this scan.'
      },
      { agent: 'claude', path: file, message: expect.stringMatching(/Invalid (?:time value|Date)/) }
    ])
  })

  it('preserves traversal ties when later metadata completes first, including the partial batch', async () => {
    const paths = await createFiles(root, 131)
    let releaseFirst = () => {}
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let reachedLater = () => {}
    const laterRead = new Promise<void>((resolve) => {
      reachedLater = resolve
    })
    fsMocks.stat.mockImplementation(async (path: string) => {
      if (path === paths[0]) {
        await firstBlocked
      }
      if (path === paths[15]) {
        reachedLater()
      }
      return Object.assign(await fs.stat(path), { mtimeMs: 1_000 })
    })

    const discovery = scan(root, [], 130)
    try {
      await laterRead
    } finally {
      releaseFirst()
    }
    expect((await discovery).files.map((file) => file.path)).toEqual(paths.slice(0, 130))
    expect(fsMocks.stat).toHaveBeenCalledTimes(paths.length)
  })

  it('bounds directory and metadata reads across simultaneous roots', async () => {
    const roots = Array.from({ length: 8 }, (_, index) => join(root, `root-${index}`))
    await Promise.all(roots.map((directory) => createFiles(directory, 70)))
    let active = 0
    let peak = 0
    async function tracked<T>(read: () => Promise<T>): Promise<T> {
      active++
      peak = Math.max(peak, active)
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        return await read()
      } finally {
        active--
      }
    }
    fsMocks.readdir.mockImplementation((path: string, options: { withFileTypes: true }) =>
      tracked(() => fs.readdir(path, options))
    )
    fsMocks.stat.mockImplementation((path: string) => tracked(() => fs.stat(path)))

    const results = await Promise.all(roots.map((directory) => scan(directory, [], 3)))
    expect(results.every((result) => result.files.length === 3)).toBe(true)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(8)
    expect(active).toBe(0)
  })

  it('sees file, sidecar, and nested membership changes on the next scan without notifications', async () => {
    const [file] = await createFiles(root, 1)
    if (!file) {
      throw new Error('missing fixture')
    }
    const sidecar = join(root, 'metadata.json')
    await fs.writeFile(sidecar, '{}')
    const args = {
      rootDir: root,
      issues: [],
      limit: 100,
      agent: 'claude' as const,
      extensions: ['.jsonl'],
      contentDependencyPath: () => sidecar
    }
    const first = await discoverFiles(args)
    await fs.writeFile(file, '{"new":true}\n')
    await fs.utimes(file, 2_000, 2_000)
    await fs.writeFile(sidecar, '{"new":true}')
    await fs.utimes(sidecar, 3_000, 3_000)
    const [added] = await createFiles(join(root, 'nested'), 1)
    const second = await discoverFiles(args)
    expect(second.files.map((entry) => entry.path)).toContain(added)
    expect(second.files.find((entry) => entry.path === file)).toMatchObject({
      sizeBytes: 13,
      mtimeMs: 2_000_000,
      sidecar: { path: sidecar, mtimeMs: 3_000_000, sizeBytes: 12 }
    })
    expect(first.files[0]?.sizeBytes).toBe(3)
    await fs.rm(file)
    expect((await discoverFiles(args)).files.map((entry) => entry.path)).not.toContain(file)
  })

  it('keeps issue ordering at the cap despite reversed metadata failures', async () => {
    const paths = await createFiles(root, 65)
    let releaseFirst = () => {}
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let reachedLater = () => {}
    const later = new Promise<void>((resolve) => {
      reachedLater = resolve
    })
    fsMocks.stat.mockImplementation(async (path: string) => {
      if (path === paths[0]) {
        await blocked
      }
      if (path === paths[15]) {
        reachedLater()
      }
      throw new Error(`unreadable ${path}`)
    })
    const issues: AiVaultScanIssue[] = Array.from({ length: 498 }, (_, index) => ({
      agent: 'claude',
      path: `previous-${index}`,
      message: 'previous issue'
    }))
    const discovery = scan(root, issues)
    try {
      await later
    } finally {
      releaseFirst()
    }
    expect((await discovery).files).toEqual([])
    expect(issues).toHaveLength(500)
    expect(issues[498]?.path).toBe(paths[0])
    expect(issues[499]?.kind).toBe('notice')
  })

  it('reports one unavailable sidecar in traversal order and distinguishes missing metadata', async () => {
    const paths = await createFiles(root, 5)
    fsMocks.stat.mockImplementation(async (path: string) => {
      if (path.endsWith('.meta')) {
        throw Object.assign(new Error('metadata refused'), {
          code: path === `${paths[0]}.meta` ? 'ENOENT' : 'EACCES'
        })
      }
      return fs.stat(path)
    })
    const issues: AiVaultScanIssue[] = []
    const discovery = await discoverFiles({
      rootDir: root,
      issues,
      limit: 100,
      agent: 'claude',
      extensions: ['.jsonl'],
      contentDependencyPath: (path) => `${path}.meta`
    })
    expect(discovery.files.find((entry) => entry.path === paths[0])?.sidecar).toBe('none')
    expect(discovery.files.filter((entry) => entry.sidecar === 'unknown')).toHaveLength(4)
    expect(issues).toEqual([
      {
        agent: 'claude',
        path: `${paths[1]}.meta`,
        message: 'Session metadata could not be read this scan.'
      }
    ])
  })

  it.skipIf(process.platform === 'win32')(
    'reads retargeted and retargeted-back roots from disk',
    async () => {
      const [a] = await createFiles(join(root, 'a'), 1)
      const [b] = await createFiles(join(root, 'b'), 1)
      const alias = join(root, 'alias')
      await fs.symlink(join(root, 'a'), alias, 'dir')
      expect((await scan(alias)).files[0]?.sizeBytes).toBe(3)
      if (!a || !b) {
        throw new Error('missing fixture')
      }
      await fs.writeFile(b, '{"target":"b"}\n')
      await fs.unlink(alias)
      await fs.symlink(join(root, 'b'), alias, 'dir')
      expect((await scan(alias)).files[0]?.sizeBytes).toBe(15)
      await fs.writeFile(a, '{"target":"a"}\n')
      await fs.unlink(alias)
      await fs.symlink(join(root, 'a'), alias, 'dir')
      expect((await scan(alias)).files[0]?.sizeBytes).toBe(15)
    }
  )
})
