import type * as NodeFsPromises from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import type * as RuntimeImportLimits from '../../ipc/runtime-import-limits'

const fsFaults: {
  beforeCopyWrite: (() => void) | null
  writeError: NodeJS.ErrnoException | null
} = vi.hoisted(() => ({ beforeCopyWrite: null, writeError: null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      fsFaults.beforeCopyWrite?.()
      if (fsFaults.writeError) {
        return Promise.reject(fsFaults.writeError)
      }
      return actual.writeFile(...args)
    }
  }
})

vi.mock('../../ipc/runtime-import-limits', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeImportLimits>()),
  REMOTE_IMPORT_MAX_FILE_BYTES: 10,
  REMOTE_IMPORT_MAX_TOTAL_BYTES: 16
}))

import { materializeDragTempPaths, type DragTempCopyEnvironment } from './dragged-temp-file-copy'

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

  it('keeps proven buffered bytes when the source changes after reading', async () => {
    const source = await dragTempFile('shot.png', 'png')
    fsFaults.beforeCopyWrite = () => appendFileSync(source, '-grown')

    const [result] = await materializeDragTempPaths([source], env)
    expect(await readFile(importedPath(result), 'utf8')).toBe('png')
    expect(await readFile(source, 'utf8')).toBe('png-grown')
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
