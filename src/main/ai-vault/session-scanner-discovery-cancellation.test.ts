import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dirent } from 'node:fs'
import type * as NodeFsPromisesModule from 'node:fs/promises'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { AI_VAULT_SCAN_CANCELLED_MESSAGE } from '../../shared/ai-vault-types'

const fsMocks = vi.hoisted(() => ({ readdir: vi.fn(), stat: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  readdir: fsMocks.readdir,
  stat: fsMocks.stat
}))

const { discoverFiles } = await import('./session-scanner-discovery')

// discoverFiles must stop issuing new work once aborted, and always surface
// the canonical cancelled-scan error shape (IPC drops Error.name).
describe('discoverFiles cancellation', () => {
  function dirent(name: string): Dirent {
    return {
      name,
      isDirectory: () => false,
      isFile: () => true,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isSymbolicLink: () => false
    } as Dirent
  }

  beforeEach(() => {
    fsMocks.readdir.mockReset()
    fsMocks.stat.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects with the canonical cancelled-scan message when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const issues: AiVaultScanIssue[] = []

    await expect(
      discoverFiles({
        rootDir: 'root',
        limit: 10,
        agent: 'codex',
        issues,
        extensions: ['.jsonl'],
        signal: controller.signal
      })
    ).rejects.toMatchObject({ message: AI_VAULT_SCAN_CANCELLED_MESSAGE, name: 'AbortError' })
    expect(fsMocks.readdir).not.toHaveBeenCalled()
  })

  it('stops issuing new stat calls once aborted mid-loop', async () => {
    const controller = new AbortController()
    const issues: AiVaultScanIssue[] = []
    const names = ['a', 'b', 'c', 'd', 'e'].map((name) => dirent(`${name}.jsonl`))
    fsMocks.readdir.mockResolvedValue(names)

    let statCalls = 0
    fsMocks.stat.mockImplementation(async () => {
      statCalls += 1
      if (statCalls === 1) {
        // Abort lands between the first and second file, mid-loop.
        controller.abort()
      }
      return { mtimeMs: 1, mtime: new Date(1), size: 1, dev: 1, ino: 1, nlink: 1 }
    })

    await expect(
      discoverFiles({
        rootDir: 'root',
        limit: 10,
        agent: 'codex',
        issues,
        extensions: ['.jsonl'],
        signal: controller.signal
      })
    ).rejects.toMatchObject({ message: AI_VAULT_SCAN_CANCELLED_MESSAGE, name: 'AbortError' })

    // Exactly the one in-flight stat call completes; no further files are
    // touched, and none of the un-statted remainder is recorded as an issue.
    expect(statCalls).toBe(1)
    expect(issues).toEqual([])
  })
})
