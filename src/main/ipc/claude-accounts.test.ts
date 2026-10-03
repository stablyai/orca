import { describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))

import type { ClaudeAccountService } from '../claude-accounts/service'
import { registerClaudeAccountHandlers } from './claude-accounts'

describe('Claude account IPC', () => {
  it('says when terminals without account switching still run, only once an account exists', async () => {
    const state = {
      accounts: [
        {
          id: 'a',
          email: 'a@example.test',
          authMethod: 'subscription-oauth' as const,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeAccountId: null
    }
    let older = true
    const service = {
      listAccounts: () => state,
      selectAccount: async () => state
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers call only the members stubbed above.
    registerClaudeAccountHandlers(service as unknown as ClaudeAccountService, () => older)
    expect(await handlers.get('claudeAccounts:list')!()).toEqual({
      ...state,
      olderTerminalsRunning: true
    })
    expect(await handlers.get('claudeAccounts:select')!({}, { accountId: null })).toEqual({
      ...state,
      olderTerminalsRunning: true
    })
    older = false
    expect(await handlers.get('claudeAccounts:list')!()).toEqual(state)
    older = true
    state.accounts = [{ ...state.accounts[0], id: 'draft', email: '' }]
    expect(await handlers.get('claudeAccounts:list')!()).toEqual(state)
    state.accounts = []
    expect(await handlers.get('claudeAccounts:list')!()).toEqual(state)
  })
})
