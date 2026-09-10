import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { installHookStatusSessionTabsRepublish } from './hook-status-session-tabs-republish'

const PANE = 'tab-provider:11111111-1111-4111-8111-111111111111'

function providerOnly(server: AgentHookServer, transcriptPath: string): void {
  server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-provider',
      worktreeId: 'repo::/worktree',
      providerSession: { key: 'session_id', id: 'pi-session', transcriptPath },
      providerSessionOnly: true,
      payload: { state: 'done', prompt: '', agentType: 'pi' }
    },
    null
  )
}

describe('hook status session-tabs republish', () => {
  it('delivers provider-only changes and authority retirement from the owner mutation stream', () => {
    const server = new AgentHookServer()
    const touch = vi.fn()
    const uninstall = installHookStatusSessionTabsRepublish(server, () => ({
      getTerminalWorktreeIdForHandle: () => null,
      getTerminalWorktreeIdForPaneKey: () => null,
      touchMobileSessionTabsForWorktree: touch
    }))
    try {
      providerOnly(server, '/sessions/first.jsonl')
      expect(touch).toHaveBeenLastCalledWith('repo::/worktree')

      touch.mockClear()
      providerOnly(server, '/sessions/first.jsonl')
      expect(touch).not.toHaveBeenCalled()

      providerOnly(server, '/sessions/replaced.jsonl')
      expect(touch).toHaveBeenCalledTimes(1)

      touch.mockClear()
      server.retirePaneAuthority(PANE)
      expect(touch).toHaveBeenCalledTimes(1)
      expect(touch).toHaveBeenCalledWith('repo::/worktree')
    } finally {
      uninstall()
    }
  })

  it('deduplicates the old and new ownership of one moved row', () => {
    const server = new AgentHookServer()
    const touch = vi.fn()
    providerOnly(server, '/sessions/first.jsonl')
    const uninstall = installHookStatusSessionTabsRepublish(server, () => ({
      getTerminalWorktreeIdForHandle: () => null,
      getTerminalWorktreeIdForPaneKey: () => null,
      touchMobileSessionTabsForWorktree: touch
    }))
    try {
      server.transferPaneAuthority(PANE, 'tab-new:22222222-2222-4222-8222-222222222222')
      expect(touch).toHaveBeenCalledTimes(1)
      expect(touch).toHaveBeenCalledWith('repo::/worktree')
    } finally {
      uninstall()
    }
  })
})
