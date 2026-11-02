import type * as NodeFs from 'node:fs'
import { appendFileSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import type * as RuntimeImportLimits from '../ipc/runtime-import-limits'

const fsFaults: {
  beforeCopyWrite: (() => void) | null
  writeError: NodeJS.ErrnoException | null
} = vi.hoisted(() => ({ beforeCopyWrite: null, writeError: null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      fsFaults.beforeCopyWrite?.()
      const stream = actual.createWriteStream(...args)
      const writeError = fsFaults.writeError
      if (writeError) {
        stream.once('open', () => stream.destroy(writeError))
      }
      return stream
    }
  }
})

vi.mock('../ipc/runtime-import-limits', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeImportLimits>()),
  REMOTE_IMPORT_MAX_FILE_BYTES: 10,
  REMOTE_IMPORT_MAX_TOTAL_BYTES: 16
}))

import {
  DRAG_TEMP_COPY_TTL_MS,
  materializeDragTempPaths,
  mayNeedDragTempCopy,
  scheduleDragTempCopySweep,
  sweepExpiredDragTempCopies,
  type DragTempCopyEnvironment
} from './dragged-temp-file-copy'

const SCREENSHOT_NAME = 'Screenshot 2026-09-28 at 4.03.11 PM.png'
const canChangePermissions = process.platform !== 'win32' && process.getuid?.() !== 0

let root: string
let env: DragTempCopyEnvironment
let providerDir: string

async function dragTempFile(name: string, content: string | Buffer): Promise<string> {
  const filePath = join(providerDir, name)
  await writeFile(filePath, content, { mode: 0o644 })
  return filePath
}

async function copyDirs(): Promise<string[]> {
  try {
    return await readdir(env.copyRoot)
  } catch {
    return []
  }
}

function importedPath(result: { status: string; destPath?: string }): string {
  expect(result.status).toBe('imported')
  return result.destPath!
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-drag-temp-test-'))
  const sourceTempRoot = join(root, 'T')
  providerDir = join(sourceTempRoot, 'TemporaryItems', 'NSIRD_screencaptureui_abc123')
  await mkdir(providerDir, { recursive: true })
  env = { platform: 'darwin', sourceTempRoot, copyRoot: join(root, 'app-temp', 'orca-drops') }
})

afterEach(async () => {
  fsFaults.beforeCopyWrite = null
  fsFaults.writeError = null
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('materializeDragTempPaths', () => {
  it('copies a drag-temp file, keeping its basename and bytes', async () => {
    const source = await dragTempFile(SCREENSHOT_NAME, 'png-bytes')

    const [result] = await materializeDragTempPaths([source], env)

    const dest = importedPath(result)
    expect(basename(dest)).toBe(SCREENSHOT_NAME)
    expect(basename(dirname(dest))).toMatch(/^orca-drop-/)
    expect(dirname(dirname(dest))).toBe(env.copyRoot)
    expect(await readFile(dest, 'utf8')).toBe('png-bytes')
  })

  it.skipIf(process.platform === 'win32')(
    'creates a 0600 copy in a 0700 directory for a 0644 source',
    async () => {
      const source = await dragTempFile('shot.png', 'x')

      const dest = importedPath((await materializeDragTempPaths([source], env))[0])

      expect((await stat(dest)).mode & 0o777).toBe(0o600)
      expect((await stat(dirname(dest))).mode & 0o777).toBe(0o700)
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'carries none of the source or provider directory xattrs',
    async () => {
      const source = await dragTempFile('shot.png', 'x')
      for (const target of [source, providerDir]) {
        const set = await runProcess({
          program: '/usr/bin/xattr',
          args: ['-w', 'com.orca.test-marker', '1', target]
        })
        expect(set.code).toBe(0)
      }

      const dest = importedPath((await materializeDragTempPaths([source], env))[0])

      for (const target of [dest, dirname(dest)]) {
        const listed = await runProcess({ program: '/usr/bin/xattr', args: [target] })
        expect(listed.stdout).not.toContain('com.orca.test-marker')
      }
    }
  )

  it('produces an empty copy for a zero-byte source', async () => {
    const source = await dragTempFile('empty.png', '')

    const dest = importedPath((await materializeDragTempPaths([source], env))[0])

    expect((await stat(dest)).size).toBe(0)
  })

  it('passes everything through off macOS', async () => {
    const source = await dragTempFile('shot.png', 'x')

    const results = await materializeDragTempPaths([source], { ...env, platform: 'linux' })

    expect(results).toEqual([{ sourcePath: source, status: 'imported', destPath: source }])
    expect(await copyDirs()).toEqual([])
  })

  it('passes through Finder paths and temp paths outside TemporaryItems/NSIRD_*', async () => {
    const finder = join(root, 'Desktop', 'shot.png')
    const otherTemp = join(env.sourceTempRoot, 'TemporaryItems', 'other', 'shot.png')
    const providerDirItself = providerDir
    await mkdir(dirname(finder), { recursive: true })
    await writeFile(finder, 'x')
    await mkdir(dirname(otherTemp), { recursive: true })
    await writeFile(otherTemp, 'x')

    const paths = [finder, otherTemp, providerDirItself, '/not/there/shot.png']
    const results = await materializeDragTempPaths(paths, env)

    expect(results.map((result) => importedPath(result))).toEqual(paths)
    expect(await copyDirs()).toEqual([])
  })

  it('passes missing TemporaryItems lookalikes outside the configured temp root through', async () => {
    const missing = join(root, 'other', 'TemporaryItems', 'NSIRD_provider', 'gone.png')

    expect(await materializeDragTempPaths([missing], env)).toEqual([
      { sourcePath: missing, status: 'imported', destPath: missing }
    ])
  })

  it.skipIf(process.platform === 'win32')(
    'passes symlinks and directories through unchanged',
    async () => {
      const target = join(root, 'outside.png')
      await writeFile(target, 'x')
      const link = join(providerDir, 'link.png')
      await symlink(target, link)
      const nested = join(providerDir, 'folder')
      await mkdir(nested)

      const results = await materializeDragTempPaths([link, nested], env)

      expect(results.map((result) => importedPath(result))).toEqual([link, nested])
      expect(await copyDirs()).toEqual([])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'treats a symlinked temp root and its real path as the same root',
    async () => {
      const source = await dragTempFile('shot.png', 'x')
      const linkedRoot = join(root, 'var-link')
      await symlink(env.sourceTempRoot, linkedRoot)
      const viaLink = join(linkedRoot, 'TemporaryItems', basename(providerDir), 'shot.png')

      const [throughLinkedSource] = await materializeDragTempPaths([viaLink], env)
      const [throughLinkedRoot] = await materializeDragTempPaths([source], {
        ...env,
        sourceTempRoot: linkedRoot
      })

      expect(importedPath(throughLinkedSource)).not.toBe(viaLink)
      expect(importedPath(throughLinkedRoot)).not.toBe(source)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not copy prefix siblings, nested lookalikes, or symlink escapes',
    async () => {
      const sibling = join(`${env.sourceTempRoot}-sibling`, 'TemporaryItems', 'NSIRD_x', 'a.png')
      const nested = join(env.sourceTempRoot, 'deep', 'TemporaryItems', 'NSIRD_x', 'a.png')
      const outsideDir = join(root, 'outside-provider')
      const escaped = join(env.sourceTempRoot, 'TemporaryItems', 'NSIRD_escape', 'a.png')
      for (const filePath of [sibling, nested, join(outsideDir, 'a.png')]) {
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, 'x')
      }
      await symlink(outsideDir, dirname(escaped))

      const paths = [sibling, nested, escaped]
      const results = await materializeDragTempPaths(paths, env)

      expect(results.map((result) => importedPath(result))).toEqual(paths)
      expect(await copyDirs()).toEqual([])
    }
  )

  it('reports a missing drag-temp file instead of passing the original through', async () => {
    const missing = join(providerDir, 'gone.png')

    expect(await materializeDragTempPaths([missing], env)).toEqual([
      { sourcePath: missing, status: 'failed', reason: 'missing' }
    ])
  })

  it.skipIf(!canChangePermissions)(
    'reports an unreadable drag-temp file as permission denied and leaves no copy',
    async () => {
      const source = await dragTempFile('locked.png', 'x')
      await chmod(source, 0o000)

      const results = await materializeDragTempPaths([source], env)

      expect(results).toEqual([
        { sourcePath: source, status: 'failed', reason: 'permission-denied' }
      ])
      expect(await copyDirs()).toEqual([])
    }
  )

  it('copies at the per-file limit and hands one byte more over uncopied', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const atLimit = await dragTempFile('ten.png', '0123456789')
    const overLimit = await dragTempFile('eleven.png', '0123456789a')

    const [accepted, uncopied] = await materializeDragTempPaths([atLimit, overLimit], env)

    expect(importedPath(accepted)).not.toBe(atLimit)
    expect(uncopied).toEqual({ sourcePath: overLimit, status: 'uncopied', reason: 'too-large' })
    expect(await copyDirs()).toHaveLength(1)
  })

  it('shares one budget within a drop, and an uncopied item does not block a smaller later one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const finder = join(root, 'big-finder-file.png')
    await writeFile(finder, 'x'.repeat(100))
    const first = await dragTempFile('a.png', '0123456789')
    const second = await dragTempFile('b.png', '0123456789')
    const third = await dragTempFile('c.png', '01234')

    const results = await materializeDragTempPaths([finder, first, second, third], env)

    expect(importedPath(results[0])).toBe(finder)
    expect(importedPath(results[1])).not.toBe(first)
    expect(results[2]).toEqual({ sourcePath: second, status: 'uncopied', reason: 'storage-full' })
    expect(importedPath(results[3])).not.toBe(third)
    expect(await copyDirs()).toHaveLength(2)
  })

  it('counts copies retained from earlier drops against the budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const first = await dragTempFile('a.png', '0123456789')
    const second = await dragTempFile('b.png', '0123456789')
    const third = await dragTempFile('c.png', '012345')

    const [firstDrop] = await materializeDragTempPaths([first], env)
    const [secondDrop] = await materializeDragTempPaths([second], env)
    const [thirdDrop] = await materializeDragTempPaths([third], env)

    expect(importedPath(firstDrop)).not.toBe(first)
    expect(secondDrop).toMatchObject({ status: 'uncopied', reason: 'storage-full' })
    expect(importedPath(thirdDrop)).not.toBe(third)
    expect(await copyDirs()).toHaveLength(2)
  })

  it('rejects a source that changes mid-copy and leaves no copy behind', async () => {
    const source = await dragTempFile('shot.png', 'png')
    fsFaults.beforeCopyWrite = () => appendFileSync(source, '-grown')

    expect(await materializeDragTempPaths([source], env)).toEqual([
      { sourcePath: source, status: 'failed', reason: 'changed' }
    ])
    expect(await readdir(env.copyRoot)).toEqual([])
  })

  it('reports a full disk as a reason token, logging the errno, and leaves no copy behind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const source = await dragTempFile('shot.png', 'png')
    fsFaults.writeError = Object.assign(new Error('ENOSPC: no space left on device, write'), {
      code: 'ENOSPC'
    })

    expect(await materializeDragTempPaths([source], env)).toEqual([
      { sourcePath: source, status: 'failed', reason: 'out-of-space' }
    ])
    expect(await readdir(env.copyRoot)).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.any(String), { code: 'ENOSPC' })
  })

  it('reports an unexpected errno as a generic copy failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const source = await dragTempFile('shot.png', 'png')
    fsFaults.writeError = Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' })

    expect(await materializeDragTempPaths([source], env)).toEqual([
      { sourcePath: source, status: 'failed', reason: 'copy-failed' }
    ])
  })

  it('reuses one copy for a duplicate source path within a batch', async () => {
    const source = await dragTempFile('shot.png', 'x')

    const [first, second] = await materializeDragTempPaths([source, source], env)

    expect(importedPath(second)).toBe(importedPath(first))
    expect(await copyDirs()).toHaveLength(1)
  })

  it('gives concurrent batches distinct copy directories', async () => {
    const source = await dragTempFile('shot.png', 'x')

    const [[left], [right]] = await Promise.all([
      materializeDragTempPaths([source], env),
      materializeDragTempPaths([source], env)
    ])

    expect(dirname(importedPath(left))).not.toBe(dirname(importedPath(right)))
    expect(await readFile(importedPath(left), 'utf8')).toBe('x')
    expect(await readFile(importedPath(right), 'utf8')).toBe('x')
  })

  it('reports a broken copy root as a storage failure, not a problem with the dropped file', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const source = await dragTempFile('shot.png', 'x')
    await mkdir(dirname(env.copyRoot), { recursive: true })
    await writeFile(env.copyRoot, 'not a directory')

    const [result] = await materializeDragTempPaths([source], env)

    expect(result).toEqual({ sourcePath: source, status: 'failed', reason: 'storage-unavailable' })
  })

  it.skipIf(!canChangePermissions)('refuses a copy root other users can read', async () => {
    const source = await dragTempFile('shot.png', 'x')
    await mkdir(env.copyRoot, { recursive: true })
    await chmod(env.copyRoot, 0o755)

    expect(await materializeDragTempPaths([source], env)).toEqual([
      { sourcePath: source, status: 'failed', reason: 'storage-not-private' }
    ])
  })

  it('stops on abort without leaving a copy behind', async () => {
    const source = await dragTempFile('shot.png', 'x')
    const controller = new AbortController()
    controller.abort(new Error('renderer gone'))

    await expect(materializeDragTempPaths([source], env, controller.signal)).rejects.toThrow(
      'renderer gone'
    )
    expect(await copyDirs()).toEqual([])
  })

  it('removes copies it already made when aborted partway through a drop', async () => {
    const first = await dragTempFile('a.png', 'a')
    const second = await dragTempFile('b.png', 'b')
    const controller = new AbortController()
    let writes = 0
    fsFaults.beforeCopyWrite = () => {
      writes += 1
      if (writes === 2) {
        controller.abort(new Error('timed out'))
      }
    }

    await expect(
      materializeDragTempPaths([first, second], env, controller.signal)
    ).rejects.toThrow()
    expect(await copyDirs()).toEqual([])
  })
})

describe('mayNeedDragTempCopy', () => {
  it('matches only files below a TemporaryItems/NSIRD_* directory on macOS', () => {
    const drag = join('/', 'var', 'T', 'TemporaryItems', 'NSIRD_screencaptureui_1', 'a.png')

    expect(mayNeedDragTempCopy(drag, 'darwin')).toBe(true)
    expect(mayNeedDragTempCopy(drag, 'linux')).toBe(false)
    expect(mayNeedDragTempCopy(dirname(drag), 'darwin')).toBe(false)
    expect(mayNeedDragTempCopy(join('/', 'Users', 'me', 'Desktop', 'a.png'), 'darwin')).toBe(false)
  })
})

describe('sweepExpiredDragTempCopies', () => {
  it('removes only expired orca-drop directories', async () => {
    const source = await dragTempFile('shot.png', 'x')
    const [oldCopy] = await materializeDragTempPaths([source], env)
    const [freshCopy] = await materializeDragTempPaths([source], env)
    const oldDir = dirname(importedPath(oldCopy))
    const freshDir = dirname(importedPath(freshCopy))
    const foreign = join(env.copyRoot, 'not-ours')
    await mkdir(foreign)
    const nowMs = Date.now()
    const expired = new Date(nowMs - DRAG_TEMP_COPY_TTL_MS - 1000)
    await utimes(oldDir, expired, expired)
    await utimes(foreign, expired, expired)

    await sweepExpiredDragTempCopies(env.copyRoot, nowMs)

    await expect(lstat(oldDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(freshDir)).isDirectory()).toBe(true)
    expect((await lstat(foreign)).isDirectory()).toBe(true)
  })

  it('does nothing when no copy root exists', async () => {
    await expect(sweepExpiredDragTempCopies(join(root, 'nope'))).resolves.toBeUndefined()
  })
})

describe('scheduleDragTempCopySweep', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sweeps on macOS shortly after startup and then hourly, scheduling only once', async () => {
    vi.useFakeTimers()
    const getCopyRoot = vi.fn(() => join(root, 'nope'))

    scheduleDragTempCopySweep(getCopyRoot, 'linux')
    expect(vi.getTimerCount()).toBe(0)

    scheduleDragTempCopySweep(getCopyRoot, 'darwin')
    scheduleDragTempCopySweep(getCopyRoot, 'darwin')
    expect(vi.getTimerCount()).toBe(2)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(getCopyRoot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(getCopyRoot).toHaveBeenCalledTimes(2)
  })
})
