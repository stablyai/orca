import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProcessHost from '@orca/process-host'

vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessHost>()
  // A machine without perl: the helper program isn't there to start.
  return {
    ...actual,
    spawnProcess: (spec: Parameters<typeof actual.spawnProcess>[0]) =>
      actual.spawnProcess({ ...spec, program: join(tmpdir(), 'orca-no-such-perl', 'perl') })
  }
})

const { moveIdleThreadLockFolder } = await import('./codex-thread-writer-locks')

describe.skipIf(process.platform === 'win32')(
  'moveIdleThreadLockFolder without the lock helper',
  () => {
    let root: string
    let account: string
    let store: string

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'orca-thread-locks-'))
      account = join(root, 'account')
      store = join(root, 'store')
      mkdirSync(join(account, 'thread-writer-locks'), { recursive: true })
      mkdirSync(join(store, 'thread-writer-locks'), { recursive: true })
    })

    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('moves a lock folder with no thread lock instead of staying busy', async () => {
      writeFileSync(join(account, 'thread-writer-locks', '.coordination.lock'), '')
      const move = vi.fn(async () => {})

      await expect(moveIdleThreadLockFolder(account, store, move)).resolves.toBe('moved')
      expect(move).toHaveBeenCalledTimes(1)
    })

    it('stays busy while a thread lock file is left', async () => {
      writeFileSync(
        join(account, 'thread-writer-locks', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.lock'),
        ''
      )
      const move = vi.fn(async () => {})

      await expect(moveIdleThreadLockFolder(account, store, move)).resolves.toBe('busy')
      expect(move).not.toHaveBeenCalled()
    })
  }
)
