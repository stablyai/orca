import { afterEach, describe, expect, it } from 'vitest'
import { installClaudeProfileRouter } from './claude-profile-installed-router'
import {
  getClaudeAuthProxy,
  startClaudeAuthProxy,
  stopClaudeAuthProxy
} from './claude-auth-proxy/claude-auth-proxy-host'
import {
  forgetClaudePaneAccount,
  getClaudePaneAccount,
  recordClaudePaneAccount
} from './claude-pane-account-registry'
import { assignClaudePaneOnExecutionHost } from './claude-pane-account-assign'

afterEach(async () => {
  forgetClaudePaneAccount('pty-1')
  installClaudeProfileRouter(undefined)
  await stopClaudeAuthProxy()
})

describe('assignClaudePaneOnExecutionHost', () => {
  it('flips a live slot to the account the client names, and ignores an unknown pane', async () => {
    await startClaudeAuthProxy()
    const proxy = getClaudeAuthProxy()
    if (!proxy) {
      throw new Error('proxy did not start')
    }
    const slot = proxy.allocateSlot('/old')
    recordClaudePaneAccount({
      ptyId: 'pty-1',
      paneKey: 'pane',
      accountId: '/old',
      configDir: '/old',
      launchedAt: 1,
      pinned: false,
      source: 'spawn',
      proxySlot: slot,
      assignedAccountId: '/old'
    })

    expect(
      assignClaudePaneOnExecutionHost({
        ptyId: 'pty-1',
        accountId: 'account-b',
        configDir: '/home/u/.claude-b'
      })
    ).toEqual({ assigned: true })
    expect(proxy.accountIdForSlot(slot)).toBe('account-b')
    expect(getClaudePaneAccount('pty-1')?.assignedAccountId).toBe('account-b')
    expect(
      assignClaudePaneOnExecutionHost({ ptyId: 'missing', accountId: 'account-b', configDir: '/x' })
    ).toEqual({ assigned: false })
    expect(assignClaudePaneOnExecutionHost({ ptyId: 'pty-1', accountId: 'account-c' })).toEqual({
      assigned: false
    })
    expect(proxy.accountIdForSlot(slot)).toBe('account-b')
  })
})
