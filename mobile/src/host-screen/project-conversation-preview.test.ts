import { describe, expect, it } from 'vitest'
import { structuredAgentSessionPaneKey } from '../../../src/shared/agent-session/view/structured-agent-session-projection'
import { getWorktreeRowIdentity } from '../worktree/worktree-host-row-identity'
import { buildProjectConversations, readConversationHistory } from './project-conversations'
import {
  conversationAgent,
  conversationHistory,
  conversationWorkspace
} from './project-conversations.test-fixture'

const defaults = {
  repos: [],
  tabs: new Map(),
  history: [],
  now: 1000,
  untitled: 'New conversation'
}

describe('conversation names and latest human previews', () => {
  it.each([true, false])(
    'keeps a live session name separate from its prompt (tab: %s)',
    (hasTab) => {
      const workspace = conversationWorkspace({
        agents: [
          conversationAgent({
            paneKey: hasTab ? structuredAgentSessionPaneKey('tab', 'session') : 'chat-pane',
            conversationName: 'Mobile navigation',
            taskTitle: 'Current work',
            prompt: 'Why does the list show my latest message?',
            lastAssistantMessage: 'I will inspect the row.'
          })
        ]
      })
      const [project] = buildProjectConversations({
        ...defaults,
        workspaces: [workspace],
        tabs: hasTab
          ? new Map([
              [
                getWorktreeRowIdentity(workspace),
                [{ type: 'agent-session', id: 'tab', sessionId: 'session', title: 'Old title' }]
              ]
            ])
          : new Map()
      })
      expect(project?.data[0]).toMatchObject({
        title: 'Mobile navigation',
        preview: 'Why does the list show my latest message?'
      })
    }
  )

  it('preserves a renamed tab on an older host without the optional conversation name', () => {
    const workspace = conversationWorkspace({
      agents: [
        conversationAgent({
          paneKey: structuredAgentSessionPaneKey('tab', 'session'),
          prompt: 'Another request'
        })
      ]
    })
    const [project] = buildProjectConversations({
      ...defaults,
      workspaces: [workspace],
      tabs: new Map([
        [
          getWorktreeRowIdentity(workspace),
          [{ type: 'agent-session', id: 'tab', sessionId: 'session', title: 'Renamed chat' }]
        ]
      ])
    })
    expect(project?.data[0]).toMatchObject({ title: 'Renamed chat', preview: 'Another request' })
  })

  it('uses the authenticated latest prompt for saved chats and searches its separate preview', () => {
    const { sessions } = readConversationHistory({
      sessions: [
        conversationHistory({
          title: 'A stable saved title',
          firstUserPrompt: 'Opening question',
          lastUserPrompt: 'Check the latest layout',
          previewMessages: [{ role: 'assistant', text: 'Result from the agent', timestamp: null }]
        })
      ]
    })
    const [project] = buildProjectConversations({
      ...defaults,
      workspaces: [],
      history: sessions,
      query: 'latest layout'
    })
    expect(project?.data[0]).toMatchObject({
      title: 'A stable saved title',
      preview: 'Check the latest layout'
    })
  })

  it.each([undefined, null])(
    'handles old or unavailable latest-prompt evidence: %s',
    (lastUserPrompt) => {
      const [project] = buildProjectConversations({
        ...defaults,
        workspaces: [],
        history: [
          conversationHistory({
            lastUserPrompt,
            previewMessages: [
              { role: 'user', text: 'First message', timestamp: null },
              { role: 'user', text: 'Last human message', timestamp: null },
              {
                role: 'user',
                text: '<system-reminder>Internal update</system-reminder>',
                timestamp: null
              },
              { role: 'tool', text: 'Tool output', timestamp: null },
              { role: 'assistant', text: 'Latest answer', timestamp: null }
            ]
          })
        ]
      })
      expect(project?.data[0]?.preview).toBe(
        lastUserPrompt === undefined ? 'Last human message' : undefined
      )
    }
  )

  it('does not substitute the opening prompt or assistant output for a missing human preview', () => {
    const [project] = buildProjectConversations({
      ...defaults,
      workspaces: [],
      history: [
        conversationHistory({
          firstUserPrompt: 'An old opening request',
          previewMessages: [{ role: 'assistant', text: 'Only an answer remains', timestamp: null }]
        })
      ]
    })
    expect(project?.data[0]?.preview).toBeUndefined()
  })
})
