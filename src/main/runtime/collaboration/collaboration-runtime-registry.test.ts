import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import type { CollaborationTopology } from './collaboration-topology'
import {
  getCollaborationRuntimeTopology,
  registerCollaborationRuntimeTopology,
  unregisterCollaborationRuntimeTopology
} from './collaboration-runtime-registry'

function createRuntime(): OrcaRuntimeService {
  return Object.create(OrcaRuntimeService.prototype) as OrcaRuntimeService
}

function topology(taskId: string): CollaborationTopology {
  return { steps: [{ taskId }] }
}

describe('collaboration-runtime-registry', () => {
  it('returns the exact registered topology without mutating it', () => {
    const runtime = createRuntime()
    const topology: CollaborationTopology = {
      steps: [{ taskId: 't1', subscribesTo: ['topic-a'] }]
    }

    registerCollaborationRuntimeTopology(runtime, 'run-1', topology)

    expect(getCollaborationRuntimeTopology(runtime, 'run-1')).toBe(topology)
    expect(topology).toEqual({ steps: [{ taskId: 't1', subscribesTo: ['topic-a'] }] })
  })

  it('rejects duplicate registration of the same run', () => {
    const runtime = createRuntime()

    registerCollaborationRuntimeTopology(runtime, 'run-1', topology('t1'))

    expect(() => registerCollaborationRuntimeTopology(runtime, 'run-1', topology('t2'))).toThrow(
      /already registered/i
    )
  })

  it('returns undefined for an unknown run on a never-registered runtime', () => {
    const runtime = createRuntime()

    expect(getCollaborationRuntimeTopology(runtime, 'run-missing')).toBeUndefined()
  })

  it('unregisters a run', () => {
    const runtime = createRuntime()

    registerCollaborationRuntimeTopology(runtime, 'run-1', topology('t1'))

    unregisterCollaborationRuntimeTopology(runtime, 'run-1')

    expect(getCollaborationRuntimeTopology(runtime, 'run-1')).toBeUndefined()
  })

  it('unregister is idempotent', () => {
    const runtime = createRuntime()

    unregisterCollaborationRuntimeTopology(runtime, 'run-1')
    unregisterCollaborationRuntimeTopology(runtime, 'run-1')

    expect(getCollaborationRuntimeTopology(runtime, 'run-1')).toBeUndefined()
  })

  it('allows re-registering a run after unregister', () => {
    const runtime = createRuntime()

    registerCollaborationRuntimeTopology(runtime, 'run-1', topology('t1'))
    unregisterCollaborationRuntimeTopology(runtime, 'run-1')
    registerCollaborationRuntimeTopology(runtime, 'run-1', topology('t2'))

    expect(getCollaborationRuntimeTopology(runtime, 'run-1')).toEqual(topology('t2'))
  })

  it('isolates run registrations per runtime', () => {
    const runtimeA = createRuntime()
    const runtimeB = createRuntime()

    registerCollaborationRuntimeTopology(runtimeA, 'run-1', topology('a'))
    registerCollaborationRuntimeTopology(runtimeB, 'run-1', topology('b'))

    expect(getCollaborationRuntimeTopology(runtimeA, 'run-1')).toEqual(topology('a'))
    expect(getCollaborationRuntimeTopology(runtimeB, 'run-1')).toEqual(topology('b'))
  })

  it('unregister on one runtime leaves another runtime untouched', () => {
    const runtimeA = createRuntime()
    const runtimeB = createRuntime()

    registerCollaborationRuntimeTopology(runtimeA, 'run-1', topology('a'))
    registerCollaborationRuntimeTopology(runtimeB, 'run-1', topology('b'))

    unregisterCollaborationRuntimeTopology(runtimeA, 'run-1')

    expect(getCollaborationRuntimeTopology(runtimeA, 'run-1')).toBeUndefined()
    expect(getCollaborationRuntimeTopology(runtimeB, 'run-1')).toEqual(topology('b'))
  })
})
