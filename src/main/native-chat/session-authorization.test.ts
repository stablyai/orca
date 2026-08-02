import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { authorizeNativeChatSession } from './session-authorization'

const providerSession = {
  key: 'session_id' as const,
  id: 'session-1',
  transcriptPath: '/trusted/session-1.jsonl'
}

function status(agentType = 'claude'): AgentStatusIpcPayload {
  return {
    paneKey: 'tab:leaf',
    state: 'done',
    prompt: '',
    agentType,
    connectionId: null,
    receivedAt: 20,
    stateStartedAt: 10,
    providerSession
  }
}

function snapshot(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'folder:/workspace',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: 'tab',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab:leaf',
        title: 'Claude',
        parentTabId: 'tab',
        leafId: 'leaf',
        isActive: true,
        agentStatus: {
          state: 'done',
          prompt: '',
          updatedAt: 30,
          stateStartedAt: 10,
          paneKey: 'tab:leaf',
          stateHistory: [],
          agentType: 'openclaude',
          providerSession
        }
      }
    ]
  }
}

describe('authorizeNativeChatSession', () => {
  it.each(['claude', 'codex', 'grok'])(
    'returns only the server-owned provider path for a matching %s session',
    (agent) => {
      expect(
        authorizeNativeChatSession({
          agent,
          sessionId: 'session-1',
          transcriptPath: '/trusted/session-1.jsonl',
          statuses: [status(agent)],
          snapshots: []
        })
      ).toEqual({ transcriptPath: '/trusted/session-1.jsonl' })
    }
  )

  it('rejects a caller path or session absent from server-owned state', () => {
    const base = { agent: 'claude', statuses: [status()], snapshots: [] }
    expect(
      authorizeNativeChatSession({
        ...base,
        sessionId: 'session-1',
        transcriptPath: '/private/other.jsonl'
      })
    ).toBeNull()
    expect(authorizeNativeChatSession({ ...base, sessionId: 'session-2' })).toBeNull()
  })

  it('authorizes compatible provider identity retained by a folder-workspace snapshot', () => {
    expect(
      authorizeNativeChatSession({
        agent: 'claude',
        sessionId: 'session-1',
        statuses: [],
        snapshots: [snapshot()]
      })
    ).toEqual({ transcriptPath: '/trusted/session-1.jsonl' })
  })

  it('does not let another provider claim the same session id', () => {
    expect(
      authorizeNativeChatSession({
        agent: 'codex',
        sessionId: 'session-1',
        statuses: [status()],
        snapshots: [snapshot()]
      })
    ).toBeNull()
  })
})
