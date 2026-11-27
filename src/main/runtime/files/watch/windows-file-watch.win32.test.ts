import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../../../shared/file-watch/filesystem-change-event'
import { watchWindowsRuntimeFileExplorer } from './windows-file-watch'

describe('watchWindowsRuntimeFileExplorer', () => {
  // libuv before 1.53 re-arms a deleted watched directory forever without an fs.watch error.
  it.runIf(process.platform === 'win32')(
    'ends the watch with a terminal error when its root directory is deleted',
    async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const root = mkdtempSync(join(tmpdir(), 'orca-windows-file-watch-'))
      const batches: FsChangeEvent[][] = []
      const terminalErrors: string[] = []
      const dispose = watchWindowsRuntimeFileExplorer(
        root,
        (events) => batches.push(events),
        (error) => terminalErrors.push(error.message)
      )
      try {
        rmSync(root, { recursive: true, force: true })

        await vi.waitFor(() => expect(terminalErrors).toEqual(['File watcher root was deleted']), {
          timeout: 5_000
        })
        expect(batches.at(-1)).toEqual([{ kind: 'overflow', absolutePath: root }])
        await expect(dispose()).resolves.toBeUndefined()
      } finally {
        consoleError.mockRestore()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
