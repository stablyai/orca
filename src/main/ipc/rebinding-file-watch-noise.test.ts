import { EventEmitter } from 'node:events'
import type * as Fs from 'node:fs'
import { mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { nativeEvents, nativeFailures } = vi.hoisted(() => {
  const nativeEvents: (() => void)[] = []
  const nativeFailures: ((error: Error) => void)[] = []
  return { nativeEvents, nativeFailures }
})

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof Fs>('node:fs')
  return {
    ...actual,
    watch: vi.fn((_path: string, _options: unknown, callback: () => void) => {
      nativeEvents.push(callback)
      // Mirrors Node: an error closes the handle without 'close', and a later close() is a no-op.
      let handleOpen = true
      const watcher: EventEmitter = Object.assign(new EventEmitter(), {
        close: () => {
          if (handleOpen) {
            handleOpen = false
            watcher.emit('close')
          }
        }
      })
      nativeFailures.push((error) => {
        handleOpen = false
        watcher.emit('error', error)
      })
      return watcher
    })
  }
})

import {
  closeFileSystemWatcher,
  watchFileAcrossReplacement,
  type RebindingFileWatch
} from './rebinding-file-watch'

let directory: string
let fileWatch: RebindingFileWatch | null

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-rebinding-noise-'))
  nativeEvents.length = 0
  nativeFailures.length = 0
  fileWatch = null
})

afterEach(async () => {
  await fileWatch?.close()
  rmSync(directory, { recursive: true, force: true })
})

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
}

describe('watchFileAcrossReplacement event filtering', () => {
  it('drops attribute-only events such as macOS mmap reads of git metadata', async () => {
    const path = join(directory, 'packed-refs')
    writeFileSync(path, 'refs')
    const onChange = vi.fn()
    fileWatch = watchFileAcrossReplacement(path, onChange, (error) => {
      throw error
    })
    await settle()

    for (let read = 0; read < 50; read++) {
      nativeEvents.at(-1)?.()
    }
    await settle()
    expect(onChange).not.toHaveBeenCalled()

    writeFileSync(path, 'refs and more')
    for (let read = 0; read < 50; read++) {
      nativeEvents.at(-1)?.()
    }
    await settle()
    expect(onChange).toHaveBeenCalledOnce()
  })
})

describe('watchFileAcrossReplacement after a watcher error', () => {
  it('closes promptly and rebinds once the runtime has closed the errored watcher', async () => {
    const path = join(directory, 'index')
    writeFileSync(path, 'index')
    const onError = vi.fn()
    fileWatch = watchFileAcrossReplacement(path, vi.fn(), onError)
    await settle()

    nativeFailures.at(-1)?.(new Error('EPERM'))
    expect(onError).toHaveBeenCalledOnce()
    expect(fileWatch.isBound()).toBe(false)
    await fileWatch.refresh()
    expect(fileWatch.isBound()).toBe(true)

    nativeFailures.at(-1)?.(new Error('EPERM'))
    const startedAt = Date.now()
    await fileWatch.close()
    fileWatch = null
    // Well under the bounded close fallback: the errored watcher is not awaited at all.
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  it('bounds closing a watcher whose close event never arrives', async () => {
    vi.useFakeTimers()
    try {
      const watcher = watch(join(directory, 'config'), { persistent: false }, () => {})
      watcher.on('error', () => {})
      nativeFailures.at(-1)?.(new Error('EPERM'))
      const settled = vi.fn()
      void closeFileSystemWatcher(watcher).then(settled)
      await vi.advanceTimersByTimeAsync(999)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
