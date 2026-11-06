import { describe, expect, it } from 'vitest'
import { emptyCrew, type OrchestrationCrewRow } from '../../../../src/shared/orchestration-crew'
import { agentReferenceNote } from '../../../../src/shared/orchestration-agent-reference'
import {
  appendCrewMention,
  crewRowSubtitle,
  mobileCrewParty,
  mobileCrewRunningWorkers,
  mobileCrewStatus,
  mobileCrewVisible,
  projectMobileCrewMentions,
  reduceCrewSubscription
} from './mobile-orchestration-crew'

function row(overrides: Partial<OrchestrationCrewRow> = {}): OrchestrationCrewRow {
  return {
    partyKey: 'worker',
    role: 'worker',
    label: 'Worker',
    agentKind: 'claude',
    status: 'working',
    sendAddress: 'term_worker',
    ...overrides
  }
}

describe('mobile orchestration crew', () => {
  it('hides the pill when the host has no crew method', () => {
    const step = reduceCrewSubscription(null, {
      type: 'error',
      error: { code: 'method_not_found', message: 'Unknown method' }
    })
    expect(step.kind).toBe('unsupported')
    expect(
      reduceCrewSubscription(null, {
        type: 'error',
        message: 'not available to mobile clients'
      }).kind
    ).toBe('unsupported')
    expect(mobileCrewVisible(emptyCrew('unknown'))).toBe(false)
    expect(mobileCrewVisible(emptyCrew('ok'))).toBe(false)
  })

  it('maps a complete snapshot to workers, running count, and statuses', () => {
    const begin = reduceCrewSubscription(null, { type: 'begin', status: 'ok' })
    expect(begin.kind).toBe('pending')
    const pending = begin.kind === 'pending' ? begin.pending : emptyCrew('ok')
    const rows = reduceCrewSubscription(pending, {
      type: 'rows',
      section: 'managing',
      rows: [
        row(),
        row({
          partyKey: 'done',
          label: 'Done',
          status: 'done',
          task: { title: 'Ship', state: 'completed' }
        }),
        row({
          partyKey: 'ask',
          label: 'Ask',
          status: 'done',
          pendingQuestion: { preview: 'Which file?', at: '2026-11-02T00:00:00Z' }
        }),
        row({
          partyKey: 'bad',
          label: 'Bad',
          status: 'done',
          task: { title: 'Fix', state: 'failed' }
        })
      ]
    })
    const complete = reduceCrewSubscription(rows.kind === 'pending' ? rows.pending : null, {
      type: 'complete'
    })
    expect(complete.kind).toBe('snapshot')
    if (complete.kind !== 'snapshot') {
      return
    }
    expect(mobileCrewVisible(complete.snapshot)).toBe(true)
    expect(mobileCrewRunningWorkers(complete.snapshot)).toBe(1)
    expect(complete.snapshot.sections.managing.map(mobileCrewStatus)).toEqual([
      'running',
      'done',
      'waiting',
      'failed'
    ])
  })

  it('does not count an idle kept-open dispatch as running', () => {
    const idle = row({
      status: 'idle',
      task: { title: 'Wait for the next turn', state: 'dispatched' }
    })
    const parked = row({
      partyKey: 'parked',
      status: 'done',
      task: { title: 'Parked', state: 'completed' }
    })
    expect(mobileCrewStatus(idle)).toBe('waiting')
    expect(mobileCrewStatus(parked)).toBe('done')
    expect(
      mobileCrewRunningWorkers({
        status: 'ok',
        sections: { managedBy: [], managing: [idle, parked], talkingWith: [] }
      })
    ).toBe(0)
  })

  it('maps an open idle dispatch to waiting, including a host that stamped the last turn done', () => {
    const openAndIdle = row({
      status: 'done',
      task: { title: 'PR babysitter', state: 'dispatched' }
    })
    expect(mobileCrewStatus(openAndIdle)).toBe('waiting')
    expect(mobileCrewStatus({ ...openAndIdle, status: 'idle' })).toBe('waiting')
    expect(
      mobileCrewStatus(
        row({ status: 'working', task: { title: 'PR babysitter', state: 'dispatched' } })
      )
    ).toBe('running')
    expect(crewRowSubtitle(openAndIdle, 'PR babysitter (Hermes)')).toBeNull()
    expect(
      crewRowSubtitle(
        {
          ...openAndIdle,
          latest: { direction: 'from', preview: 'PR babysitter (Hermes)', at: 't', sequence: 1 }
        },
        'PR babysitter (Hermes)'
      )
    ).toBeNull()
    expect(
      crewRowSubtitle(
        {
          ...openAndIdle,
          latest: { direction: 'from', preview: 'Waiting for the next wake', at: 't', sequence: 2 }
        },
        'PR babysitter (Hermes)'
      )
    ).toBe('Waiting for the next wake')
  })

  it('uses the terminal handle for a terminal tab and the session address for a chat', () => {
    expect(mobileCrewParty({ type: 'terminal', terminal: 'term_agent', sessionId: 'sess_1' })).toBe(
      'term_agent'
    )
    expect(mobileCrewParty({ type: 'agent-session', sessionId: 'sess_1234' })).toBe(
      'orca_session_id:sess_1234'
    )
    expect(mobileCrewParty({ type: 'markdown' })).toBeNull()
  })

  it('inserts a mention token and projects the routing note on send', () => {
    const draft = appendCrewMention('Look at ', row({ label: 'Worker' }))
    expect(draft).toBe('Look at @Worker (Orca agent term_worker) ')
    expect(projectMobileCrewMentions(draft)).toBe(
      `Look at @Worker\n\n${agentReferenceNote('Worker', 'term_worker')}`
    )
    expect(projectMobileCrewMentions('plain')).toBe('plain')
    expect(appendCrewMention('hi', row({ sendAddress: undefined }))).toBe('hi')
  })
})
