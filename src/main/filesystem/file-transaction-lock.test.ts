import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as ProperLockfile from 'proper-lockfile'
import { afterEach, expect, it, vi } from 'vitest'
import { withFileTransactionLock } from './file-transaction-lock'

const { compromisedSeen } = vi.hoisted(() => ({ compromisedSeen: { notify: () => {} } }))

// Refresh at proper-lockfile's minimum interval and report compromise to the test.
vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = await importOriginal<typeof ProperLockfile>()
  return {
    ...actual,
    lock: (file: string, options: ProperLockfile.LockOptions) =>
      actual.lock(file, {
        ...options,
        stale: 2_000,
        update: 1_000,
        onCompromised: (error) => {
          compromisedSeen.notify()
          if (!options.onCompromised) {
            throw error // proper-lockfile's default
          }
          options.onCompromised(error)
        }
      })
  }
})

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('fails the transaction instead of throwing from the refresh timer when the lock is lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-file-transaction-lock-'))
  roots.push(root)
  const filePath = join(root, 'agent-session-recovery.json')

  const transaction = withFileTransactionLock(filePath, async () => {
    const lost = new Promise<void>((resolve) => {
      compromisedSeen.notify = resolve
    })
    // Another instance treating the lock as stale removes it; the next mtime refresh then fails.
    await rm(`${filePath}.lock`, { recursive: true, force: true })
    await lost
    return 'written'
  })

  await expect(transaction).rejects.toThrow(/Lost the lock on .*agent-session-recovery\.json/)
})
