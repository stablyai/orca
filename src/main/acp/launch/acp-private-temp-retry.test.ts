import { existsSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { acpRemoveFolderOptions, acpRunFolder } from './acp-private-temp'

describe('acp private temp retry cleanup', () => {
  it('deterministically configures rm options for win32 and non-win32 platforms', () => {
    // Windows: 5 retries with 100ms backoff to clear transient EBUSY locks
    const winOptions = acpRemoveFolderOptions('win32')
    expect(winOptions).toEqual({
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    })

    // macOS: 1 retry with 100ms backoff
    const macOptions = acpRemoveFolderOptions('darwin')
    expect(macOptions).toEqual({
      recursive: true,
      force: true,
      maxRetries: 1,
      retryDelay: 100
    })

    // Linux: 1 retry with 100ms backoff
    const linuxOptions = acpRemoveFolderOptions('linux')
    expect(linuxOptions).toEqual({
      recursive: true,
      force: true,
      maxRetries: 1,
      retryDelay: 100
    })
  })

  it('passes platform-configured retry options to rm during cleanup', async () => {
    const root = join(tmpdir(), `test-acp-options-${Date.now()}`)
    const rmSpy = vi.spyOn(fsPromises, 'rm')

    try {
      const { path, remove } = await acpRunFolder(root)
      expect(existsSync(path)).toBe(true)

      await remove()

      expect(rmSpy).toHaveBeenCalledWith(path, acpRemoveFolderOptions())
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSpy.mockRestore()
    }
  })

  it('creates and cleanly removes temporary run folder with files', async () => {
    const root = join(tmpdir(), `test-acp-lifecycle-${Date.now()}`)
    const { path, remove } = await acpRunFolder(root)

    expect(existsSync(path)).toBe(true)

    const testFile = join(path, 'temp-child.lock')
    await fsPromises.writeFile(testFile, 'locked content')
    expect(existsSync(testFile)).toBe(true)

    await remove()
    expect(existsSync(path)).toBe(false)
  })
})
