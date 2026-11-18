import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { orcaStopRowBody } from '../termination/structured-agent-session-orca-stop-row'
import { crashCutResumeMarker } from './structured-agent-session-crash-cut-marker'
import {
  pendingApproval,
  record,
  turnItem,
  SESSION,
  NOW
} from './testing/structured-agent-session-restart-resume.test-fixture'

const TURN = { kind: 'turn', turnItemId: 'turn:turn-1' } as const
const STARTED = NOW + 100
/** What this start's settlement wrote. */
const settled = { recovered: true, recoveredAt: STARTED + 1 } as const

function crashCut(): AgentJournalRenderItem {
  return {
    itemId: 'orca:stale-stop',
    revision: 1,
    body: orcaStopRowBody(undefined, 'crash'),
    sequence: 4,
    observedAt: NOW + 5,
    ...settled,
    turnScope: TURN
  }
}

function backgroundTask(state: 'unverifiable' | 'done' = 'unverifiable'): AgentJournalRenderItem {
  return {
    itemId: 'orca:background-task',
    revision: 2,
    body: {
      kind: 'message',
      role: 'system',
      blocks: [
        {
          type: 'background-task',
          taskId: 'bg-1',
          kind: 'command',
          label: 'Sleep 45 seconds in background',
          state
        }
      ]
    },
    sequence: 3,
    observedAt: NOW,
    ...settled,
    turnScope: TURN
  }
}

function derive(items: AgentJournalRenderItem[]) {
  return crashCutResumeMarker({
    sessionId: SESSION,
    items,
    cursor: { epoch: 'epoch-1', sequence: 9 },
    record: record(),
    crashedRuntime: 'runtime-crashed',
    settledSince: STARTED
  })
}

const interrupted = () => ({ ...turnItem('turn-1', 'interrupted', 'user-1'), ...settled })

describe('crash cut resume marker', () => {
  it('offers the turn a crash cut, as a quit would', () => {
    expect(derive([interrupted(), crashCut()])).toMatchObject({
      work: { kind: 'turn', id: 'turn-1' },
      trigger: 'crash',
      teardownId: 'crash:runtime-crashed',
      recordedAt: STARTED + 1,
      activity: { state: 'working', prompts: [], tasks: [] }
    })
  })

  it('offers a finished turn whose background work the crash cut', () => {
    expect(derive([turnItem('turn-1', 'completed'), backgroundTask()])?.activity).toEqual({
      state: 'done',
      prompts: [],
      tasks: [{ kind: 'command', label: 'Sleep 45 seconds in background' }]
    })
  })

  it('marks a turn cut while it asked the person as waiting on them', () => {
    const asked = pendingApproval()
    const cancelled: AgentJournalRenderItem = {
      ...asked,
      body: { ...asked.body, resolution: { ...asked.body.resolution, state: 'cancelled' } },
      ...settled,
      turnScope: TURN
    }
    expect(derive([interrupted(), cancelled, crashCut()])?.activity).toEqual({
      state: 'blocked',
      prompts: [{ kind: 'approval', label: 'Run the command?' }],
      tasks: []
    })
  })

  it('offers nothing when the chat moved on, the crash cut nothing, or an older start settled it', () => {
    const later: AgentJournalRenderItem = {
      itemId: 'user-2',
      revision: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'next' }] },
      sequence: 5,
      observedAt: NOW + 6
    }
    expect(derive([interrupted(), crashCut(), later])).toBeNull()
    expect(derive([turnItem('turn-1', 'completed')])).toBeNull()
    expect(derive([turnItem('turn-1', 'completed'), backgroundTask('done')])).toBeNull()
    const older = { recovered: true, recoveredAt: STARTED - 1 } as const
    expect(
      derive([
        { ...interrupted(), ...older },
        { ...crashCut(), ...older }
      ])
    ).toBeNull()
  })
})
