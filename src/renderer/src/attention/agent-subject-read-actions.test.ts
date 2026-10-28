import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emitAgentSubjectReads,
  registerAgentSubjectReadCapture,
  subscribeAgentSubjectReads,
  type AgentSubjectRead,
  type StructuredSubjectRead
} from './agent-subject-read-actions'

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0).toReversed()) {
    stop()
  }
  vi.restoreAllMocks()
})

const structured: StructuredSubjectRead = {
  sessionId: 'session',
  target: { kind: 'environment', environmentId: 'host' },
  observedCursor: { epoch: 'epoch', sequence: 1 },
  observationKey: 'observed'
}

describe('agent subject read batch index', () => {
  it('shares one first-read-wins index without changing captured order or filtering', () => {
    const first: AgentSubjectRead = { subjectKey: 'one' }
    const duplicate: AgentSubjectRead = { subjectKey: 'one', structured }
    const second: AgentSubjectRead = { subjectKey: 'two', structured }
    const batches: {
      reads: readonly AgentSubjectRead[]
      index: ReadonlyMap<string, AgentSubjectRead>
    }[] = []
    stops.push(
      subscribeAgentSubjectReads((reads, index) => batches.push({ reads, index })),
      subscribeAgentSubjectReads((reads, index) => batches.push({ reads, index }))
    )
    emitAgentSubjectReads(['one', 'two'], [first, duplicate, { subjectKey: 'excluded' }, second])
    expect(batches[0]?.reads).toEqual([first, duplicate, second])
    expect(batches[0]?.index.size).toBe(2)
    expect(batches[0]?.index.get('one')).toBe(first)
    expect(batches[0]?.index.get('two')).toBe(second)
    expect(batches[1]?.index).toBe(batches[0]?.index)
    emitAgentSubjectReads(['two'], [second])
    expect(batches[2]?.index).not.toBe(batches[0]?.index)
    expect(batches[2]?.index.size).toBe(1)
    expect(batches[2]?.index.get('two')).toBe(second)
  })

  it('captures explicit reads, isolates listener errors, and retires subscriptions', () => {
    const capture = vi.fn(() => structured)
    stops.push(registerAgentSubjectReadCapture('one', capture))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stopFailure = subscribeAgentSubjectReads(() => {
      throw new Error('listener failed')
    })
    const observed: StructuredSubjectRead[] = []
    const stopSurvivor = subscribeAgentSubjectReads((_reads, index) => {
      const read = index.get('one')?.structured
      if (read) {
        observed.push(read)
      }
    })
    stops.push(stopFailure, stopSurvivor)
    emitAgentSubjectReads(['one'], undefined, 'explicit')
    expect(capture).toHaveBeenCalledWith('explicit')
    expect(observed).toEqual([structured])
    expect(warning).toHaveBeenCalledOnce()
    stopFailure()
    emitAgentSubjectReads(['one'], undefined, 'explicit')
    expect(observed).toEqual([structured, structured])
    expect(warning).toHaveBeenCalledOnce()
    stopSurvivor()
    emitAgentSubjectReads(['one'], undefined, 'explicit')
    expect(observed).toHaveLength(2)
  })
})
