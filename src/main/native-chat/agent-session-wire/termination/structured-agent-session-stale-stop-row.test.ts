import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  noteProviderRelayReattachedFromLastRun,
  providerRelayKeptFromLastRun
} from '../../../provider-relay/provider-relay-launch-inventory'
import { staleStopRow } from './structured-agent-session-stale-stop-row'

const turn: AgentJournalRenderItem = {
  itemId: 'turn-1',
  revision: 1,
  body: { kind: 'turn', turnId: 't1', state: 'running' },
  sequence: 1,
  observedAt: 0
}

describe('stale stop row for a chat whose agent was kept', () => {
  it('a Stop after a mid-turn reattach is never worded as closed by quit', () => {
    // Reattached at launch; the Stop has since ended the relay, so nothing live says "kept" any more.
    noteProviderRelayReattachedFromLastRun('chat-kept')
    expect(providerRelayKeptFromLastRun('chat-kept')).toBe(true)
    const cutByLastRun = () => ({ by: 'replaced' as const, fence: 2 })
    const replaced = { fence: 2, runtimeEnd: 'quit' as const }

    expect(
      staleStopRow(
        {
          sessionId: 'chat-kept',
          deathEvidence: null,
          replaced: {
            ...replaced,
            ...(providerRelayKeptFromLastRun('chat-kept') ? { kept: true as const } : {})
          }
        },
        [turn],
        cutByLastRun
      )
    ).toBeNull()
    // A chat whose agent really stopped at quit still says so.
    expect(
      staleStopRow({ sessionId: 'chat-cut', deathEvidence: null, replaced }, [turn], cutByLastRun)
        ?.body.orcaStop
    ).toEqual({ cause: 'quit' })
  })
})
