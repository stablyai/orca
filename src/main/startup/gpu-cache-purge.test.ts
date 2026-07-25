import type * as NodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GPU_CACHE_DIRECTORY_NAMES, purgeGpuCaches } from './gpu-cache-purge'

// Why: a locked cache directory is a Windows-only failure in the wild; this fakes it
// so the `failed` bookkeeping is covered without a platform-specific (or root-skipped) test.
const { unremovableDirectory } = vi.hoisted(() => ({ unremovableDirectory: { name: '' } }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    rmSync: (target: Parameters<typeof actual.rmSync>[0], options?: object) => {
      if (unremovableDirectory.name && basename(String(target)) === unremovableDirectory.name) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      return actual.rmSync(target, options)
    }
  }
})

describe('purgeGpuCaches', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-gpu-cache-purge-test-'))
    unremovableDirectory.name = ''
  })

  afterEach(() => {
    unremovableDirectory.name = ''
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('removes populated GPU cache directories', () => {
    for (const name of GPU_CACHE_DIRECTORY_NAMES) {
      mkdirSync(join(userDataPath, name, 'nested'), { recursive: true })
      writeFileSync(join(userDataPath, name, 'nested', 'entry.bin'), 'shader')
    }

    const result = purgeGpuCaches(userDataPath)

    expect(result.removed).toEqual([...GPU_CACHE_DIRECTORY_NAMES])
    expect(result.failed).toEqual([])
    for (const name of GPU_CACHE_DIRECTORY_NAMES) {
      expect(existsSync(join(userDataPath, name))).toBe(false)
    }
  })

  it('reports nothing removed when no caches exist', () => {
    expect(purgeGpuCaches(userDataPath)).toEqual({ removed: [], failed: [] })
  })

  it('leaves unrelated userData entries alone', () => {
    mkdirSync(join(userDataPath, 'GPUCache'), { recursive: true })
    writeFileSync(join(userDataPath, 'orca-data.json'), '{}')

    purgeGpuCaches(userDataPath)

    expect(existsSync(join(userDataPath, 'orca-data.json'))).toBe(true)
  })

  // Why: this runs on the path to a relaunch — a missing userData dir must not throw.
  it('does not throw for a missing userData directory', () => {
    expect(() => purgeGpuCaches(join(userDataPath, 'absent'))).not.toThrow()
  })

  it('reports a locked cache directory as failed and still purges the rest', () => {
    for (const name of GPU_CACHE_DIRECTORY_NAMES) {
      mkdirSync(join(userDataPath, name), { recursive: true })
    }
    unremovableDirectory.name = 'ShaderCache'

    const result = purgeGpuCaches(userDataPath)

    expect(result.failed).toEqual(['ShaderCache'])
    expect(result.removed).toEqual(
      GPU_CACHE_DIRECTORY_NAMES.filter((name) => name !== 'ShaderCache')
    )
    expect(existsSync(join(userDataPath, 'ShaderCache'))).toBe(true)
    expect(existsSync(join(userDataPath, 'GPUCache'))).toBe(false)
  })

  // Why: a locked directory must not abort the relaunch it precedes.
  it('does not throw when a cache directory cannot be removed', () => {
    mkdirSync(join(userDataPath, 'GPUCache'), { recursive: true })
    unremovableDirectory.name = 'GPUCache'

    expect(() => purgeGpuCaches(userDataPath)).not.toThrow()
  })
})
