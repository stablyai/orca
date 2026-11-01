import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../src/shared/stable-pane-id'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/agent-session/view/structured-agent-session-projection'
import { sidebarSessionTabForPane, sidebarSessionTabs } from './sidebar-session-tab'

const LEAF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('sidebarSessionTabs', () => {
  it('reads tab identity and skips entries that are not tabs', () => {
    expect(
      sidebarSessionTabs({
        tabs: [
          { type: 'terminal', id: 'term', parentTabId: 'parent', leafId: LEAF },
          { type: 'note' },
          null,
          { type: 'agent-session', id: 'chat', sessionId: 'sess-1' }
        ]
      })
    ).toEqual([
      { type: 'terminal', id: 'term', parentTabId: 'parent', leafId: LEAF, sessionId: undefined },
      {
        type: 'agent-session',
        id: 'chat',
        parentTabId: undefined,
        leafId: undefined,
        sessionId: 'sess-1'
      }
    ])
  })

  it('rejects a reply that is not a tab list', () => {
    expect(sidebarSessionTabs(null)).toBeNull()
    expect(sidebarSessionTabs({ tabs: 'no' })).toBeNull()
  })
})

describe('sidebarSessionTabForPane', () => {
  it('matches a terminal by its parent tab and leaf', () => {
    const paneKey = makePaneKey('parent', LEAF)
    const tabs = sidebarSessionTabs({
      tabs: [
        { type: 'terminal', id: 'leaf-row', parentTabId: 'parent', leafId: LEAF },
        { type: 'terminal', id: 'other', leafId: LEAF }
      ]
    })
    expect(tabs && sidebarSessionTabForPane(tabs, paneKey)?.id).toBe('leaf-row')
  })

  it('matches an agent session by its structured pane, and ignores a child that is not a tab', () => {
    const sessionId = 'claude_1'
    const paneKey = structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
    const tabs = sidebarSessionTabs({
      tabs: [{ type: 'agent-session', id: 'chat-tab', sessionId }]
    })
    expect(tabs && sidebarSessionTabForPane(tabs, paneKey)?.id).toBe('chat-tab')
    expect(tabs && sidebarSessionTabForPane(tabs, makePaneKey('missing', LEAF))).toBeUndefined()
  })
})
