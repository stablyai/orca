import { describe, expect, it, vi } from 'vitest'
import { createAcpStructuredLaunchResolver } from '../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import type { JournalLoad } from '../../native-chat/agent-session-journal/replay/journal-open'
import { acpLaunchSpecFor } from './acp-launch-registry'
import { createJournalReducerState } from '../../native-chat/agent-session-journal/projection/journal-reducer'
import { spellProviderTimelineKey } from '../../native-chat/agent-session-timeline/provider-timeline-identity'

const gemini = acpLaunchSpecFor('gemini')
if (!gemini) {
  throw new Error('Gemini ACP launch spec is missing')
}
const identity = {
  sessionId: 'session-alpha-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  providerHandle: null
}

function journalWithTurns(...providerSessions: string[]): JournalLoad {
  const state = createJournalReducerState(identity.sessionId, 'epoch-1')
  providerSessions.forEach((providerSession, index) => {
    const turnId = spellProviderTimelineKey(providerSession, {
      source: 'provider',
      value: `prompt:m${index}`
    })
    state.items.set(`turn-${index}`, {
      itemId: `turn-${index}`,
      revision: 1,
      sequence: index + 2,
      observedAt: 1,
      body: { kind: 'turn', turnId, state: 'completed' }
    })
  })
  return { state, newer: null, damage: null }
}

describe('Gemini ACP resume boundary', () => {
  it.each([
    ['an exchanged turn', () => journalWithTurns('acp-1')],
    [
      'an unreadable journal',
      () => {
        throw new Error('unreadable')
      }
    ]
  ])(
    'refuses a created Gemini handle with %s before any environment lookup',
    async (_label, readJournal) => {
      const record: AgentSessionRecord = {
        ...agentSessionRecordFixture(),
        provider: 'gemini',
        accountHome: { variable: 'GEMINI_CLI_HOME', path: '/accounts/gemini' },
        providerHandleChain: [
          {
            linkId: 'created-link',
            origin: 'created',
            mintedAtFence: 1,
            observedAt: 1,
            handle: { transport: 'acp', agent: 'gemini', nativeId: 'acp-1' }
          }
        ]
      }
      const resolveEnvironment = vi.fn(async () => ({}))
      const resolve = createAcpStructuredLaunchResolver(gemini, {
        store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
        readJournal,
        resolveEnvironment
      })
      await expect(resolve({ identity: { ...identity, agent: 'gemini' } })).rejects.toMatchObject({
        name: 'AgentSessionPreSpawnError',
        reason: 'providerResumeUnavailable'
      })
      expect(resolveEnvironment).not.toHaveBeenCalled()
    }
  )
})
