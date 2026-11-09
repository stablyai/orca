import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emitAgentSubjectReads,
  registerAgentSubjectReadCapture,
  subscribeAgentSubjectReads,
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
