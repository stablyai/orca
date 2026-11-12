import { EventEmitter } from 'node:events'
import type * as Fs from 'node:fs'
import { mkdtempSync, rmSync, watch } from 'node:fs'
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

import { closeFileSystemWatcher } from './rebinding-file-watch'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-rebinding-noise-'))
  nativeEvents.length = 0
  nativeFailures.length = 0
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('watchFileAcrossReplacement after a watcher error', () => {
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
