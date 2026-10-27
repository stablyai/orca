import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchFileAcrossReplacement, type RebindingFileWatch } from './rebinding-file-watch'

let directory: string
let fileWatch: RebindingFileWatch | null

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-rebinding-file-watch-'))
  fileWatch = null
})

afterEach(async () => {
  await fileWatch?.close()
  rmSync(directory, { recursive: true, force: true })
})

function replaceAtomically(path: string, content: string): void {
  const temporary = `${path}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(temporary, content)
  renameSync(temporary, path)
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
}

describe('watchFileAcrossReplacement', () => {
  it('keeps reporting writes across repeated atomic replacement', async () => {
    const path = join(directory, 'index')
    writeFileSync(path, '0')
    const onChange = vi.fn()
    fileWatch = watchFileAcrossReplacement(path, onChange, (error) => {
      throw error
    })
    await settle()
    onChange.mockClear()

    for (const content of ['1', '2', '3']) {
      const before = onChange.mock.calls.length
      replaceAtomically(path, content)
      await vi.waitFor(() => expect(onChange.mock.calls.length).toBeGreaterThan(before), {
        timeout: 5_000
      })
      // Let the post-event re-stat rebind to the new inode before the next write.
      await settle()
    }
    const before = onChange.mock.calls.length
    writeFileSync(path, 'in place')
    await vi.waitFor(() => expect(onChange.mock.calls.length).toBeGreaterThan(before), {
      timeout: 5_000
    })
  })

  it('ignores writes to siblings and subdirectories of the watched file', async () => {
    const path = join(directory, 'HEAD')
    writeFileSync(path, 'ref: refs/heads/main')
    const onChange = vi.fn()
    fileWatch = watchFileAcrossReplacement(path, onChange, (error) => {
      throw error
    })
    await settle()
    onChange.mockClear()

    writeFileSync(join(directory, 'FETCH_HEAD'), 'noise')
    replaceAtomically(join(directory, 'last-status.json'), '{}')
    await settle()

    expect(onChange).not.toHaveBeenCalled()
  })

  it('binds a file created after the watch started once refreshed', async () => {
    const path = join(directory, 'packed-refs')
    const onChange = vi.fn()
    fileWatch = watchFileAcrossReplacement(path, onChange, (error) => {
      throw error
    })
    expect(fileWatch.isBound()).toBe(false)
    await fileWatch.refresh()
    expect(onChange).not.toHaveBeenCalled()

    writeFileSync(path, 'created')
    await fileWatch.refresh()
    expect(onChange).toHaveBeenCalledOnce()
    expect(fileWatch.isBound()).toBe(true)
    await settle()
    onChange.mockClear()

    writeFileSync(path, 'updated')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5_000 })
  })

  it('drops the binding when the file is deleted and reports nothing after close', async () => {
    const path = join(directory, 'config')
    writeFileSync(path, 'a')
    const onChange = vi.fn()
    fileWatch = watchFileAcrossReplacement(path, onChange, (error) => {
      throw error
    })
    await settle()
    rmSync(path)
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5_000 })
    expect(fileWatch.isBound()).toBe(false)

    writeFileSync(path, 'b')
    await fileWatch.refresh()
    expect(fileWatch.isBound()).toBe(true)
    await fileWatch.close()
    onChange.mockClear()
    writeFileSync(path, 'c')
    await settle()
    expect(onChange).not.toHaveBeenCalled()
  })
})
