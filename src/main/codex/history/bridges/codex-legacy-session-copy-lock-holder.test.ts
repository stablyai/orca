import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const helper = vi.hoisted(() => ({ released: false }))

vi.mock('../shared-store/codex-thread-writer-locks', () => ({
  holdThreadLockFolders: async () => {
    helper.released = false
    return {
      stillHeld: () => !helper.released,
      release: async () => {
        helper.released = true
      }
    }
  }
}))

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-legacy-copy-locks-'))
  vi.useFakeTimers()
  vi.resetModules()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

it('never lets go of a window while a caller is checking its lock', async () => {
  const { legacyCopyLocks } = await import('./codex-legacy-session-copy-lock-holder')
  const folders = [join(root, 'a'), join(root, 'b')]
  await legacyCopyLocks.whileUnlocked(folders, [], async () => undefined)
  vi.advanceTimersByTime(249)

  // The window's end passes while the lock-file check is still on disk.
  const ranUnheld = legacyCopyLocks.whileUnlocked(
    folders,
    ['0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'],
    async () => helper.released
  )
  vi.advanceTimersByTime(60)

  expect(await ranUnheld).toBe(false)
})
