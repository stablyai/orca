import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { AgentSessionLeaseEventListeners } from './agent-session-record-lease-events'

type Lease = AgentSessionRecord['lease']

function record(lease: Partial<Lease>): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: collect reads only `lease`; the rest of the record is irrelevant here.
  return { lease: { handoffStage: null, handoffOperationId: null, ...lease } } as AgentSessionRecord
}

describe('lease events a transaction raises', () => {
  it('tells handoff listeners only of a handoff that ended, after the commit', () => {
    const listeners = new AgentSessionLeaseEventListeners()
    expect(listeners.empty).toBe(true)
    const ended: string[] = []
    const stop = listeners.onHandoffEnded((sessionId) => ended.push(sessionId))
    expect(listeners.empty).toBe(false)
    const before = new Map<string, Lease>([
      ['ending', record({ handoffStage: 'recovering' }).lease],
      ['still', record({ handoffOperationId: 'op-1' }).lease],
      ['idle', record({}).lease]
    ])
    const events = listeners.collect(
      before,
      new Map([
        ['ending', record({})],
        ['still', record({ handoffOperationId: 'op-1' })],
        ['idle', record({})],
        ['starting', record({ handoffStage: 'recovering' })]
      ])
    )
    expect(ended).toEqual([])
    listeners.notify(events)
    expect(ended).toEqual(['ending'])
    stop()
    listeners.notify(events)
    expect(ended).toEqual(['ending'])
  })
})
