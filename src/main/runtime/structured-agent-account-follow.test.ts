import { describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../shared/agent-session-provider-handle-encoding'
import { createStructuredAgentAccountFollow } from './structured-agent-account-follow'

const codexHome = (path: string): AgentSessionAccountHome => ({ variable: 'CODEX_HOME', path })
const claudeHome = (path: string): AgentSessionAccountHome => ({
  variable: 'CLAUDE_CONFIG_DIR',
  path
})

function chat(
  provider: 'codex' | 'claude' | 'gemini',
  accountHome: AgentSessionAccountHome,
  conversation: boolean,
  confirmed = true
): AgentSessionRecord {
  const handle =
    provider === 'claude'
      ? claudeProviderHandle('claude-session', null)
      : codexProviderHandle('thread-1')
  return {
    ...agentSessionRecordFixture(),
    provider,
    accountHome,
    ...(confirmed ? { accountHomeConfirmed: true } : {}),
    providerHandleChain: conversation
      ? [{ linkId: 'link-1', handle, origin: 'created', mintedAtFence: 1, observedAt: 1 }]
      : []
  }
}

function follow(selected: AgentSessionAccountHome, options: { owns?: boolean } = {}) {
  const carryCodex = vi.fn(async () => true)
  const carryClaude = vi.fn(async () => true)
  const resolveSelectedHome = vi.fn(async () => selected)
  const created = createStructuredAgentAccountFollow({
    ownsAccounts: () => options.owns ?? true,
    resolveSelectedHome,
    getSettings: () => ({
      codexManagedAccounts: [
        {
          id: 'codex-b',
          email: 'b@example.com',
          managedHomePath: '/homes/b',
          createdAt: 0,
          updatedAt: 0,
          lastAuthenticatedAt: 0
        }
      ],
      activeCodexManagedAccountId: 'codex-b',
      claudeManagedAccounts: [],
      activeClaudeManagedAccountId: null
    }),
    carryCodex,
    carryClaude
  })
  return { ...created, carryCodex, carryClaude, resolveSelectedHome }
}

describe('createStructuredAgentAccountFollow', () => {
  it('carries a Codex thread to the selected account and names it', async () => {
    const f = follow(codexHome('/homes/b'))
    expect(await f.move(chat('codex', codexHome('/homes/a'), true))).toEqual({
      accountHome: codexHome('/homes/b'),
      account: 'b@example.com'
    })
    expect(f.carryCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        sourceHome: '/homes/a',
        targetHome: '/homes/b'
      })
    )
    expect(f.resolveSelectedHome).toHaveBeenCalledWith(expect.anything(), 'launch')
  })

  it('carries a Claude transcript and names System default by omission', async () => {
    const f = follow(claudeHome('/claude/default'))
    expect(await f.move(chat('claude', claudeHome('/claude/work'), true))).toEqual({
      accountHome: claudeHome('/claude/default')
    })
    expect(f.carryClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'claude-session',
        sourceHomes: ['/claude/work'],
        targetHome: '/claude/default'
      })
    )
  })

  it('stays when the conversation could not be carried', async () => {
    const f = follow(codexHome('/homes/b'))
    f.carryCodex.mockResolvedValue(false)
    expect(await f.move(chat('codex', codexHome('/homes/a'), true))).toBeNull()
  })

  it('moves a chat with no conversation yet without carrying anything', async () => {
    const f = follow(codexHome('/homes/b'))
    expect(await f.move(chat('codex', codexHome('/homes/a'), false))).toMatchObject({
      accountHome: codexHome('/homes/b')
    })
    expect(f.carryCodex).not.toHaveBeenCalled()
  })

  it('leaves a chat already on the selected account', async () => {
    const f = follow(codexHome('/homes/a'))
    expect(await f.move(chat('codex', codexHome('/homes/a'), true))).toBeNull()
    expect(f.carryCodex).not.toHaveBeenCalled()
  })

  it('quietly seeds an older Claude chat, which already launched on the selected account', async () => {
    const f = follow(claudeHome('/claude/default'))
    expect(await f.move(chat('claude', claudeHome('/claude/work'), true, false))).toEqual({
      accountHome: claudeHome('/claude/default'),
      quiet: true
    })
    expect(await f.move(chat('claude', claudeHome('/claude/default'), true, false))).toEqual({
      accountHome: claudeHome('/claude/default'),
      quiet: true
    })
    // Codex chats always launched on their record's account, so theirs is already accurate.
    const codex = follow(codexHome('/homes/b'))
    expect(await codex.move(chat('codex', codexHome('/homes/b'), true, false))).toBeNull()
  })

  it('never moves other agents, or chats on a host whose accounts another machine decides', async () => {
    const other = follow(codexHome('/homes/b'))
    expect(await other.selectedHome(chat('gemini', codexHome('/homes/a'), true))).toBeNull()
    expect(await other.move(chat('gemini', codexHome('/homes/a'), true))).toBeNull()
    const pushed = follow(codexHome('/homes/b'), { owns: false })
    expect(await pushed.selectedHome(chat('codex', codexHome('/homes/a'), true))).toBeNull()
    expect(await pushed.move(chat('codex', codexHome('/homes/a'), true))).toBeNull()
    expect(pushed.resolveSelectedHome).not.toHaveBeenCalled()
  })
})
