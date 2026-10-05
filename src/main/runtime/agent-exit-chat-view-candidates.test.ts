import { describe, expect, it } from 'vitest'
import { collectAgentExitChatViewCandidates } from './agent-exit-chat-view-candidates'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-mobile-session-tab-contracts'

function row(overrides: Partial<RuntimeMobileSessionTerminalTab>): RuntimeMobileSessionTerminalTab {
  return {
    type: 'terminal',
    id: `${overrides.parentTabId ?? 'tab'}::${overrides.leafId ?? 'A'}`,
    title: 't',
    parentTabId: 'tab',
    leafId: 'A',
    ptyId: 'pty-a',
    isActive: true,
    ...overrides
  }
}

function snapshot(
  tabs: RuntimeMobileSessionTerminalTab[]
): [string, RuntimeMobileSessionTabsSnapshot] {
  return [
    'wt',
    {
      worktree: 'wt',
      publicationEpoch: 'e',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs
    }
  ]
}

describe('collectAgentExitChatViewCandidates', () => {
  it('lists the chat-owning pane of a split and the sole pane of an ownerless chat tab', () => {
    const layout = { root: null, activeLeafId: null, expandedLeafId: null, chatLeafId: 'B' }
    expect(
      collectAgentExitChatViewCandidates([
        snapshot([
          row({ leafId: 'A', ptyId: 'pty-a', viewMode: 'chat', parentLayout: layout }),
          row({ leafId: 'B', ptyId: 'pty-b', viewMode: 'chat', parentLayout: layout }),
          row({ parentTabId: 'solo', leafId: 'S', ptyId: 'pty-s', viewMode: 'chat' })
        ])
      ]).map((candidate) => [candidate.kind, candidate.ptyId])
    ).toEqual([
      ['owner', 'pty-b'],
      ['owner', 'pty-s']
    ])
  })

  it('lists an unswitched sole pane launched as a supported agent (the phone may show it as chat)', () => {
    expect(
      collectAgentExitChatViewCandidates([
        snapshot([row({ launchAgent: 'claude' }), row({ parentTabId: 'shell', ptyId: 'pty-x' })])
      ]).map((candidate) => [candidate.kind, candidate.ptyId])
    ).toEqual([['legacy', 'pty-a']])
  })

  it('never lists terminal tabs, unswitched splits, or panes with no bound PTY', () => {
    expect(
      collectAgentExitChatViewCandidates([
        snapshot([
          row({ viewMode: 'terminal', launchAgent: 'claude' }),
          row({ parentTabId: 'split', leafId: 'A', launchAgent: 'claude' }),
          row({ parentTabId: 'split', leafId: 'B', launchAgent: 'claude' }),
          row({ parentTabId: 'nopty', ptyId: null, viewMode: 'chat' })
        ])
      ])
    ).toEqual([])
  })
})
