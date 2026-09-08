import { describe, expect, it, vi } from 'vitest'
import { webHostAccountsOperations } from './web-host-accounts-operations'

describe('web host accounts operations', () => {
  it('adapts the shared screen contract to typed account bridge requests', async () => {
    const snapshot = accountSnapshot()
    const unsubscribe = vi.fn()
    let listener: ((event: unknown) => void) | null = null
    const client = {
      account: {
        snapshot: vi.fn(async () => snapshot),
        select: vi.fn(async () => null),
        subscribe: vi.fn((onEvent) => {
          listener = onEvent
          return { ready: Promise.resolve(), unsubscribe }
        })
      }
    }
    const operations = webHostAccountsOperations(client as never, 'Paired Desktop')
    const onSnapshot = vi.fn()

    await expect(operations.loadHostName('host')).resolves.toBe('Paired Desktop')
    await expect(operations.snapshot()).resolves.toBe(snapshot)
    await operations.select('codex', 'codex-1')
    const cleanup = operations.subscribe(onSnapshot)
    listener?.({ type: 'snapshot', snapshot })

    expect(client.account.select).toHaveBeenCalledWith({
      provider: 'codex',
      accountId: 'codex-1'
    })
    expect(onSnapshot).toHaveBeenCalledWith(snapshot)
    cleanup()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})

function accountSnapshot() {
  return {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: null,
      codex: null,
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
}
