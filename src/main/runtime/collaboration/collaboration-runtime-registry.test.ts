import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import type { CollaborationTopology } from './collaboration-topology'
import { get, register, unregister } from './collaboration-runtime-registry'

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

    register(runtime, 'run-1', topology)

    expect(get(runtime, 'run-1')).toBe(topology)
    expect(topology).toEqual({ steps: [{ taskId: 't1', subscribesTo: ['topic-a'] }] })
  })

  it('rejects duplicate registration of the same run', () => {
    const runtime = createRuntime()

    register(runtime, 'run-1', topology('t1'))

    expect(() => register(runtime, 'run-1', topology('t2'))).toThrow(/already registered/i)
  })

  it('returns undefined for an unknown run on a never-registered runtime', () => {
    const runtime = createRuntime()

    expect(get(runtime, 'run-missing')).toBeUndefined()
  })

  it('unregisters a run', () => {
    const runtime = createRuntime()

    register(runtime, 'run-1', topology('t1'))

    unregister(runtime, 'run-1')

    expect(get(runtime, 'run-1')).toBeUndefined()
  })

  it('unregister is idempotent', () => {
    const runtime = createRuntime()

    unregister(runtime, 'run-1')
    unregister(runtime, 'run-1')

    expect(get(runtime, 'run-1')).toBeUndefined()
  })

  it('allows re-registering a run after unregister', () => {
    const runtime = createRuntime()

    register(runtime, 'run-1', topology('t1'))
    unregister(runtime, 'run-1')
    register(runtime, 'run-1', topology('t2'))

    expect(get(runtime, 'run-1')).toEqual(topology('t2'))
  })

  it('isolates run registrations per runtime', () => {
    const runtimeA = createRuntime()
    const runtimeB = createRuntime()

    register(runtimeA, 'run-1', topology('a'))
    register(runtimeB, 'run-1', topology('b'))

    expect(get(runtimeA, 'run-1')).toEqual(topology('a'))
    expect(get(runtimeB, 'run-1')).toEqual(topology('b'))
  })

  it('unregister on one runtime leaves another runtime untouched', () => {
    const runtimeA = createRuntime()
    const runtimeB = createRuntime()

    register(runtimeA, 'run-1', topology('a'))
    register(runtimeB, 'run-1', topology('b'))

    unregister(runtimeA, 'run-1')

    expect(get(runtimeA, 'run-1')).toBeUndefined()
    expect(get(runtimeB, 'run-1')).toEqual(topology('b'))
  })
})
