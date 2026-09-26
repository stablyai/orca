import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../shared/terminal-tab-types'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'
import { resolveWorktreeAgentConversationNames } from './runtime-worktree-agent-conversation-name'

const TAB_ID = 'tab-patient'
const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'

function tab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: TAB_ID,
    ptyId: null,
    worktreeId: 'wt-1',
    title: '✳ Claude Code',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function source(overrides: Partial<RuntimeWorktreeAgentSource> = {}): RuntimeWorktreeAgentSource {
  return {
    paneKey: `${TAB_ID}:${LEAF}`,
    tabId: TAB_ID,
    connectionId: null,
    state: 'done',
    agentType: 'claude',
    prompt: 'sync the chart',
    lastAssistantMessage: 'Done',
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

describe('resolveWorktreeAgentConversationNames', () => {
  it('sends the user-set tab title instead of a status title', () => {
    const names = resolveWorktreeAgentConversationNames({
      sources: [source()],
      tabsByWorktree: { 'wt-1': [tab({ customTitle: 'Patient sync spike' })] },
      generatedTitlesEnabled: false,
      orchestrationByPaneKey: null
    })

    expect(names.get(source().paneKey)).toBe('Patient sync spike')
  })

  it('uses a generated title only when that setting is on', () => {
    const tabsByWorktree = {
      'wt-1': [tab({ generatedTitle: 'Fix intake flow', title: '✳ Investigate replay bug' })]
    }
    const sources = [source()]
    expect(
      resolveWorktreeAgentConversationNames({
        sources,
        tabsByWorktree,
        generatedTitlesEnabled: true,
        orchestrationByPaneKey: null
      }).get(source().paneKey)
    ).toBe('Fix intake flow')
    expect(
      resolveWorktreeAgentConversationNames({
        sources,
        tabsByWorktree,
        generatedTitlesEnabled: false,
        orchestrationByPaneKey: null
      }).get(source().paneKey)
    ).toBe('Investigate replay bug')
  })

  it('does not treat a pure status title as a conversation name', () => {
    const names = resolveWorktreeAgentConversationNames({
      sources: [source()],
      tabsByWorktree: { 'wt-1': [tab({ title: '✳ Claude Code' })] },
      generatedTitlesEnabled: false,
      orchestrationByPaneKey: null
    })

    expect(names.has(source().paneKey)).toBe(false)
  })

  it('keeps a shared tab’s live title off sibling panes, but keeps a manual rename', () => {
    const sibling = source({
      paneKey: `${TAB_ID}:${OTHER_LEAF}`,
      tabId: TAB_ID
    })
    const names = resolveWorktreeAgentConversationNames({
      sources: [source(), sibling],
      tabsByWorktree: {
        'wt-1': [tab({ customTitle: null, title: '✳ Linear work log' })]
      },
      generatedTitlesEnabled: false,
      orchestrationByPaneKey: null
    })

    expect(names.size).toBe(0)

    const renamed = resolveWorktreeAgentConversationNames({
      sources: [source(), sibling],
      tabsByWorktree: {
        'wt-1': [tab({ customTitle: 'Patient sync spike', title: '✳ Linear work log' })]
      },
      generatedTitlesEnabled: false,
      orchestrationByPaneKey: null
    })
    expect(renamed.get(source().paneKey)).toBe('Patient sync spike')
    expect(renamed.get(sibling.paneKey)).toBe('Patient sync spike')
  })

  it('does not give a child the parent tab name', () => {
    const names = resolveWorktreeAgentConversationNames({
      sources: [source()],
      tabsByWorktree: { 'wt-1': [tab({ customTitle: 'Parent session' })] },
      generatedTitlesEnabled: false,
      orchestrationByPaneKey: {
        [source().paneKey]: { parentPaneKey: `${TAB_ID}:${OTHER_LEAF}` }
      }
    })

    expect(names.has(source().paneKey)).toBe(false)
  })

  it('uses the provider session id for the vault title', () => {
    const named = resolveWorktreeAgentConversationNames({
      sources: [source({ providerSessionId: 's1' })],
      tabsByWorktree: {
        'wt-1': [
          tab({
            title: '✳ Claude Code',
            aiVaultTitle: { agent: 'claude', sessionId: 's1', title: 'Fix the lease probe' }
          })
        ]
      },
      generatedTitlesEnabled: false,
      orchestrationByPaneKey: null
    })
    expect(named.get(source().paneKey)).toBe('Fix the lease probe')

    const otherSession = resolveWorktreeAgentConversationNames({
      sources: [source({ providerSessionId: 'other' })],
      tabsByWorktree: {
        'wt-1': [
          tab({
            title: '✳ Claude Code',
            aiVaultTitle: { agent: 'claude', sessionId: 's1', title: 'Fix the lease probe' }
          })
        ]
      },
      generatedTitlesEnabled: false,
      orchestrationByPaneKey: null
    })
    expect(otherSession.has(source().paneKey)).toBe(false)
  })

  it('does not give an unfocused agent the focused sibling pane title', () => {
    const names = resolveWorktreeAgentConversationNames({
      sources: [source()],
      tabsByWorktree: { 'wt-1': [tab({ title: '✳ Linear work log' })] },
      terminalLayoutsByTabId: { [TAB_ID]: splitLayout(OTHER_LEAF) },
      generatedTitlesEnabled: false,
      orchestrationByPaneKey: null
    })
    expect(names.has(source().paneKey)).toBe(false)

    const focused = resolveWorktreeAgentConversationNames({
      sources: [source()],
      tabsByWorktree: { 'wt-1': [tab({ title: '✳ Linear work log' })] },
      terminalLayoutsByTabId: { [TAB_ID]: splitLayout(LEAF) },
      generatedTitlesEnabled: false,
      orchestrationByPaneKey: null
    })
    expect(focused.get(source().paneKey)).toBe('Linear work log')
  })

  it('keeps a manual rename when the agent pane is not focused', () => {
    const names = resolveWorktreeAgentConversationNames({
      sources: [source()],
      tabsByWorktree: {
        'wt-1': [tab({ customTitle: 'Patient sync spike', title: '✳ Linear work log' })]
      },
      terminalLayoutsByTabId: { [TAB_ID]: splitLayout(OTHER_LEAF) },
      generatedTitlesEnabled: false,
      orchestrationByPaneKey: null
    })
    expect(names.get(source().paneKey)).toBe('Patient sync spike')
  })

  it('names a structured native-chat row from its unified tab', () => {
    const tabId = 'structured-agent-session-s1'
    const row = source({ tabId, paneKey: `${tabId}:${LEAF}` })
    const unifiedTabs = {
      'wt-1': [
        {
          id: tabId,
          contentType: 'agent-session',
          customLabel: 'Patient sync spike',
          label: 'Claude Chat',
          agentSessionAgent: 'claude' as const
        }
      ]
    }
    expect(
      resolveWorktreeAgentConversationNames({
        sources: [row],
        tabsByWorktree: {},
        unifiedTabs,
        generatedTitlesEnabled: false,
        orchestrationByPaneKey: null
      }).get(row.paneKey)
    ).toBe('Patient sync spike')

    const placeholder = resolveWorktreeAgentConversationNames({
      sources: [row],
      tabsByWorktree: {},
      unifiedTabs: {
        'wt-1': [{ ...unifiedTabs['wt-1'][0], customLabel: null }]
      },
      generatedTitlesEnabled: true,
      orchestrationByPaneKey: null
    })
    expect(placeholder.has(row.paneKey)).toBe(false)

    expect(
      resolveWorktreeAgentConversationNames({
        sources: [row],
        tabsByWorktree: {},
        unifiedTabs: {
          'wt-1': [
            { ...unifiedTabs['wt-1'][0], customLabel: null, generatedLabel: 'Fix intake flow' }
          ]
        },
        generatedTitlesEnabled: true,
        orchestrationByPaneKey: null
      }).get(row.paneKey)
    ).toBe('Fix intake flow')
  })
})

function splitLayout(activeLeafId: string): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF },
      second: { type: 'leaf', leafId: OTHER_LEAF }
    },
    activeLeafId,
    expandedLeafId: null
  }
}
