import { expect, it, vi } from 'vitest'
import { createChatTabLayoutQueue } from './agent-session-tab-layout-queue'
import type { ChatTabLayoutCommand } from './agent-session/agent-session-tab-layout'

const open = (sessionId: string) => ({
  worktreeId: 'wt',
  change: { open: { sessionId, agent: 'codex' as const, tabId: `tab-${sessionId}` } }
})

it('asks no host of a worktree with no saved session, and goes on past a change that fails', async () => {
  const applied: string[] = []
  const hostIdOf = vi.fn((): never => {
    throw new Error('folder_workspace_not_found')
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const queue = createChatTabLayoutQueue({
    sessionOf: () => null,
    hostIdOf,
    apply: async (command: ChatTabLayoutCommand) => {
      if (command.type === 'openAgentSessionTab' && command.sessionId === 'a') {
        throw new Error('layout_store_unavailable')
      }
      applied.push(command.type === 'openAgentSessionTab' ? command.sessionId : 'close')
      return { ok: true, result: {} }
    }
  })

  queue(() => [open('a')])
  queue(() => [open('b')])
  await vi.waitFor(() => expect(applied).toEqual(['b']))

  expect(hostIdOf).not.toHaveBeenCalled()
  expect(warn).toHaveBeenCalledOnce()
  warn.mockRestore()
})

it('goes on past a batch whose changes cannot be read', async () => {
  const applied: string[] = []
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const queue = createChatTabLayoutQueue({
    sessionOf: () => null,
    hostIdOf: () => 'local',
    apply: async (command: ChatTabLayoutCommand) => {
      applied.push(command.type === 'openAgentSessionTab' ? command.sessionId : 'close')
      return { ok: true, result: {} }
    }
  })

  queue(() => {
    throw new Error('session store unreadable')
  })
  queue(() => [open('b')])
  await vi.waitFor(() => expect(applied).toEqual(['b']))

  expect(warn).toHaveBeenCalledOnce()
  warn.mockRestore()
})
