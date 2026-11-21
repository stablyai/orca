import { describe, expect, it, vi } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from '../daemon-pty-router'
import type * as Inventory from '../daemon-session-owner-inventory'

const indexed = vi.hoisted(() => vi.fn())
vi.mock('../daemon-session-owner-inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof Inventory>()
  return {
    ...actual,
    indexDaemonOwnerInventory: (...args: Parameters<typeof actual.indexDaemonOwnerInventory>) => {
      indexed()
      return actual.indexDaemonOwnerInventory(...args)
    }
  }
})

describe('a daemon listing a terminal exit outdated', () => {
  it('indexes none of its rows, since every reader discards it', async () => {
    const current = createAdapter('current', ['shell-a'])
    const router = new DaemonPtyRouter({ current, legacy: [] })
    await router.discoverLegacySessions()
    indexed.mockClear()
    vi.mocked(current.listProcesses).mockImplementationOnce(async () => {
      current.emitExit('shell-a', 0)
      return [{ id: 'shell-a', cwd: '', title: '' }]
    })

    await expect(router.listProcesses()).rejects.toThrow('stale inventory')
    expect(indexed).not.toHaveBeenCalled()
  })
})
