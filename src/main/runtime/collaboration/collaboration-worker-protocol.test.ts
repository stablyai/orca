import { describe, expect, it } from 'vitest'
import { createCollaborationTopology } from './collaboration-topology'
import {
  buildCollaborationWorkerProtocol,
  buildCollaborationWorkerProtocolForTask,
  type CollaborationWorkerProtocolInput
} from './collaboration-worker-protocol'

const protocol = (
  overrides: Partial<CollaborationWorkerProtocolInput> = {}
): CollaborationWorkerProtocolInput => ({
  cli: 'orca',
  workerHandle: 'worker-1',
  publishesTo: [],
  requiredPublishesTo: [],
  subscribesTo: [],
  ...overrides
})

describe('buildCollaborationWorkerProtocol', () => {
  it('returns no protocol when every topic list is empty', () => {
    expect(buildCollaborationWorkerProtocol(protocol())).toBe('')
  })

  describe('publisher section', () => {
    it('lists allowed publish topics and the publish command for a producer-only worker', () => {
      const out = buildCollaborationWorkerProtocol(protocol({ publishesTo: ['alpha', 'beta'] }))
      expect(out).toContain('=== COLLABORATION: PUBLISHER ===')
      expect(out).toContain('Allowed publish topics')
      expect(out).toContain('- alpha')
      expect(out).toContain('- beta')
      expect(out).toContain('orca orchestration collaboration-publish --from worker-1')
      expect(out).toContain('--topic <topic> --semantic-type <semantic-type> --priority <priority>')
      expect(out).toContain('--body')
      expect(out).not.toContain('=== COLLABORATION: SUBSCRIBER ===')
    })

    it('lists REQUIRED publish topics separately, and only when nonempty', () => {
      const withRequired = buildCollaborationWorkerProtocol(
        protocol({ publishesTo: ['alpha'], requiredPublishesTo: ['gate-topic'] })
      )
      expect(withRequired).toContain('REQUIRED publish topics')
      expect(withRequired).toContain('- gate-topic')

      const withoutRequired = buildCollaborationWorkerProtocol(protocol({ publishesTo: ['alpha'] }))
      expect(withoutRequired).not.toContain('REQUIRED publish topics')
    })

    it('requires a successful Published result on required topics before worker_done', () => {
      const out = buildCollaborationWorkerProtocol(
        protocol({ requiredPublishesTo: ['release-notes'] })
      )
      expect(out).toContain('worker_done')
      expect(out).toMatch(/Published/)
      expect(out).toMatch(/required/i)
    })

    it('derives admitted semantic types and minimum priorities for each required topic', () => {
      const topology = createCollaborationTopology([
        { taskId: 'producer', publishesTo: ['gate'], requiredPublishesTo: ['gate'] },
        {
          taskId: 'subscriber-a',
          subscribesTo: ['gate'],
          admission: { acceptedTypes: ['finding', 'report'], minPriority: 'high' }
        },
        {
          taskId: 'subscriber-b',
          subscribesTo: ['gate'],
          admission: { acceptedTypes: ['finding'], minPriority: 'normal' }
        }
      ])

      const out = buildCollaborationWorkerProtocolForTask({
        topology,
        taskId: 'producer',
        workerHandle: 'worker-1'
      })!

      expect(out).toContain('- gate')
      expect(out).toMatch(/semantic-type finding.*minimum priority normal/i)
      expect(out).toMatch(/semantic-type report.*minimum priority high/i)
      expect(out).toContain('--semantic-type <semantic-type> --priority <priority>')
    })

    it('states that a required publish reaching zero subscribers does not satisfy completion', () => {
      const out = buildCollaborationWorkerProtocol(
        protocol({ requiredPublishesTo: ['release-notes'] })
      )
      expect(out).toMatch(/0 subscriber/i)
      expect(out).toMatch(/does not satisfy/i)
      expect(out).toMatch(/escalate/i)
    })

    it('does not reference admission guidance when the direct builder received none', () => {
      const out = buildCollaborationWorkerProtocol(
        protocol({ requiredPublishesTo: ['release-notes'] })
      )
      expect(out).not.toMatch(/combinations shown above/i)
    })

    it('prefers a runtime-selected SSH CLI over the caller devMode fallback', () => {
      const topology = createCollaborationTopology([
        { taskId: 'producer', publishesTo: ['gate'], requiredPublishesTo: ['gate'] },
        {
          taskId: 'subscriber',
          subscribesTo: ['gate'],
          admission: { acceptedTypes: ['finding'], minPriority: 'normal' }
        }
      ])

      const out = buildCollaborationWorkerProtocolForTask({
        topology,
        taskId: 'producer',
        workerHandle: 'worker-1',
        devMode: true,
        cliCommand: 'orca'
      })!

      expect(out).toContain('orca orchestration collaboration-publish')
      expect(out).not.toContain('orca-dev orchestration collaboration-publish')
    })

    it('states subscribers are topology-derived and never named by the publisher', () => {
      const out = buildCollaborationWorkerProtocol(protocol({ publishesTo: ['alpha'] }))
      expect(out).toMatch(/topology-derived/i)
      expect(out).toMatch(/never named by the publisher/i)
      expect(out).not.toMatch(/--subscriber/)
    })

    it('recovers from an unknown mutation result via --retry-request with the Orca-printed id, never inventing a publication id', () => {
      const out = buildCollaborationWorkerProtocol(protocol({ publishesTo: ['alpha'] }))
      expect(out).toContain('--retry-request <id>')
      expect(out).toMatch(/retry the exact command/i)
      expect(out).toMatch(/never invent a publication id/i)
    })

    it('never emits obsolete task/dispatch/publication id flags', () => {
      const out = buildCollaborationWorkerProtocol(
        protocol({ publishesTo: ['alpha'], requiredPublishesTo: ['gate'], subscribesTo: ['beta'] })
      )
      expect(out).not.toContain('--task-id')
      expect(out).not.toContain('--dispatch-id')
      expect(out).not.toContain('--publication-id')
    })

    it('includes --dispatch-capability on commands when present and omits it otherwise', () => {
      const withCap = buildCollaborationWorkerProtocol(
        protocol({ publishesTo: ['alpha'], dispatchCapability: 'orchestration:collab' })
      )
      expect(withCap).toContain('--dispatch-capability orchestration:collab')

      const withoutCap = buildCollaborationWorkerProtocol(protocol({ publishesTo: ['alpha'] }))
      expect(withoutCap).not.toContain('--dispatch-capability')
    })
  })

  describe('subscriber section', () => {
    it('lists subscribed topics and the nonblocking checkpoint for a subscriber-only worker', () => {
      const out = buildCollaborationWorkerProtocol(protocol({ subscribesTo: ['alpha', 'gamma'] }))
      expect(out).toContain('=== COLLABORATION: SUBSCRIBER ===')
      expect(out).toContain('- alpha')
      expect(out).toContain('- gamma')
      expect(out).toContain('orca orchestration collaboration-checkpoint --from worker-1')
      expect(out).not.toContain('=== COLLABORATION: PUBLISHER ===')
    })

    it('uses a safe nonblocking checkpoint at stage boundaries and forbids poll or sleep loops', () => {
      const out = buildCollaborationWorkerProtocol(protocol({ subscribesTo: ['alpha'] }))
      expect(out).toMatch(/never poll or sleep-loop/i)
      expect(out).toMatch(/without blocking/i)
    })

    it('allows repeated event-driven blocking checkpoints while concrete task-required context is still missing', () => {
      const out = buildCollaborationWorkerProtocol(protocol({ subscribesTo: ['alpha', 'beta'] }))
      expect(out).toContain('--wait --timeout-ms 60000')
      expect(out).toContain('worker_done')
      expect(out).not.toMatch(/exactly one blocking/i)
      expect(out).toMatch(/one blocking checkpoint at a time/i)
      expect(out).toMatch(/incorporat.*ack/i)
      expect(out).toMatch(/still missing/i)
      expect(out).toMatch(/another blocking checkpoint/i)
      expect(out).toMatch(/timeout|cancel/i)
      expect(out).toMatch(/no useful/i)
      expect(out).toMatch(/escalat/i)
      expect(out).toMatch(/do not report success/i)
    })

    it('acknowledges message ids only after incorporation via collaboration-ack with a JSON array', () => {
      const out = buildCollaborationWorkerProtocol(protocol({ subscribesTo: ['alpha'] }))
      expect(out).toContain('orca orchestration collaboration-ack --from worker-1')
      expect(out).toContain('--message-ids')
      expect(out).toMatch(/JSON array/i)
      expect(out).toMatch(/after you have incorporated/i)
    })
  })

  it('emits both sections for a worker that publishes and subscribes', () => {
    const out = buildCollaborationWorkerProtocol(
      protocol({
        publishesTo: ['alpha'],
        requiredPublishesTo: ['gate'],
        subscribesTo: ['beta']
      })
    )
    expect(out).toContain('=== COLLABORATION: PUBLISHER ===')
    expect(out).toContain('=== COLLABORATION: SUBSCRIBER ===')
  })
})
