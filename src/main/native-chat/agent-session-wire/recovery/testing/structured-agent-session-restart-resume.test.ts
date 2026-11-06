import { describe, expect, it } from 'vitest'
import { structuredAgentSessionResumableSet } from '../structured-agent-session-restart-resume-set'
import { structuredAgentSessionWorkingAtStop } from '../../termination/structured-agent-session-working-at-teardown'
import {
  childRecord,
  CLAUDE_ROOT,
  claudeRecord,
  journal,
  TEARDOWN_CURRENT,
  marker,
  NOW,
  record,
  resumableSet,
  SESSION,
  submission,
  turnItem
} from './structured-agent-session-restart-resume-test-harness'

type StopInput = Parameters<typeof structuredAgentSessionWorkingAtStop>[0]

function markersAtTeardown(
  input: Omit<StopInput, 'sessionId' | 'session'> & {
    sessions: ReadonlyMap<string, NonNullable<StopInput['session']>>
  }
) {
  return [...input.sessions].flatMap(([sessionId, session]) => {
    const recorded = structuredAgentSessionWorkingAtStop({ ...input, sessionId, session })
    return recorded ? [recorded] : []
  })
}

describe('deriving what was working at teardown', () => {
  // Persisted running rows prove no live execution; only this runtime’s child can justify a witness.
  it('marks nothing for a stale running row this host was not executing', () => {
    expect(
      markersAtTeardown({
        sessions: new Map([
          [SESSION, { journal: journal([turnItem('turn-1', 'running')]), child: null }]
        ]),
        getRecord: () => record(),
        childWorkOpen: () => false,
        childWork: () => undefined,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  // Capture lost prompts with the same work snapshot so blocked offers name what they lost.

  it('marks nothing for a settled lead whose tasks have all finished', () => {
    expect(
      markersAtTeardown({
        sessions: new Map([
          [
            SESSION,
            {
              journal: journal([turnItem('turn-1', 'completed')]),
              child: { fence: 1, phase: 'ready' as const }
            }
          ]
        ]),
        getRecord: () => record(),
        childWorkOpen: () => false,
        childWork: () => [
          childRecord({ id: 'task-a', kind: 'agent', state: 'done' }),
          childRecord({ id: 'task-b', kind: 'command', state: 'idle' })
        ],
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  it('marks nothing for a session that never proved a provider cursor', () => {
    expect(
      markersAtTeardown({
        sessions: new Map([
          [
            SESSION,
            {
              journal: journal([turnItem('turn-1', 'running')]),
              child: { fence: 1, phase: 'ready' as const }
            }
          ]
        ]),
        getRecord: () => record({ chain: [] }),
        childWorkOpen: () => false,
        childWork: () => undefined,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  // Claude may echo user input long after dispatch; mark the send before any turn ID exists.

  it('marks nothing for a session whose only work is a message still queued', () => {
    const queued = { ...submission('msg-1', 'pending'), handoverRecorded: true as const }
    expect(
      markersAtTeardown({
        sessions: new Map([
          [
            SESSION,
            {
              journal: journal([turnItem('turn-0', 'completed')], [queued]),
              child: { fence: 1, phase: 'ready' as const }
            }
          ]
        ]),
        getRecord: () => claudeRecord(null),
        childWorkOpen: () => false,
        childWork: () => undefined,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  it('marks a handed-over message over a newer queued one, and a turn a queued one waits behind', () => {
    const handedOver = {
      ...submission('msg-1', 'pending'),
      handoverRecorded: true as const,
      handedOverAt: NOW
    }
    const queued = { ...submission('msg-2', 'pending'), handoverRecorded: true as const }
    const markers = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-0', 'completed')], [handedOver, queued]),
            child: { fence: 1, phase: 'ready' as const }
          }
        ],
        [
          'session-running',
          {
            journal: journal([turnItem('turn-1', 'running')], [queued]),
            child: { fence: 1, phase: 'ready' as const }
          }
        ]
      ]),
      getRecord: () => claudeRecord(null),
      childWorkOpen: () => false,
      childWork: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(markers.map((entry) => entry.work)).toEqual([
      { kind: 'submission', id: 'msg-1' },
      { kind: 'turn', id: 'turn-1' }
    ])
  })
})

describe('the resumable set', () => {
  // Same-teardown close advances Claude’s leaf; comparing full keys would permanently reject continuity.
  it('still offers a Claude session whose leaf advanced after the marker was written', () => {
    const { candidates } = structuredAgentSessionResumableSet({
      markers: [marker({ providerHandleRoot: CLAUDE_ROOT })],
      getRecord: () => claudeRecord('5aed93d6-advanced-leaf'),
      supportsRecord: () => true,
      latestPrompt: () => '',
      movedOn: () => false,
      savedByNewerOrca: () => false
    })

    expect(candidates).toHaveLength(1)
  })

  it('withdraws and reports for deletion a Claude session that forked to a different root', () => {
    const forked = marker({ providerHandleRoot: CLAUDE_ROOT })
    const set = structuredAgentSessionResumableSet({
      markers: [forked],
      getRecord: () => claudeRecord(null, 'prov-session-2'),
      supportsRecord: () => true,
      latestPrompt: () => '',
      movedOn: () => false,
      savedByNewerOrca: () => false
    })

    expect(set.candidates).toEqual([])
    expect(set.superseded).toEqual([forked])
  })

  it("neither offers nor spends a newer Orca's chat, and offers it once this build can open it", () => {
    const offer = marker()
    expect(resumableSet({ markers: [offer], savedByNewerOrca: [SESSION] })).toEqual({
      candidates: [],
      superseded: []
    })
    expect(resumableSet({ markers: [offer] }).candidates).toHaveLength(1)
  })

  // Structural refusal must preserve a durable offer the user still owns.
  it('does not report a structurally refused marker for deletion', () => {
    expect(resumableSet({ markers: [marker()], chain: [] }).superseded).toEqual([])
  })

  // Provider-authored restore rows cannot overturn teardown’s observed work.
})
