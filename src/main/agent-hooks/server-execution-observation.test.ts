import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

beforeEach(() => {
  _internals.resetCachesForTests()
})

describe('host execution observation publication', () => {
  it('publishes evidence into the existing row and advances unchanged captures', () => {
    const server = new AgentHookServer()
    const publisher = server.createStatusStorePublisher({
      executionHostId: 'local',
      ownerEpoch: 'host-epoch'
    })
    const listener = vi.fn()
    server.setListener(listener)
    server.ingestRemote(
      { paneKey: PANE, payload: { state: 'waiting', agentType: 'codex' } },
      'conn-1'
    )
    listener.mockClear()
    const frames: unknown[] = []
    const unsubscribe = publisher.subscribe((frame) => frames.push(frame))
    frames.length = 0

    const first = {
      executionId: 'exec-1',
      hostId: 'local' as const,
      hostEpoch: 'epoch-1',
      captureRevision: 1,
      observedAt: 1_000,
      inventoryCoverage: 'complete' as const,
      verdict: 'live' as const
    }
    const second = { ...first, captureRevision: 2 }
    expect(server.publishExecutionObservation(PANE, first)).toBe(true)
    expect(server.getStatusSnapshot()[0]?.executionObservation).toEqual(first)
    expect(listener).toHaveBeenCalledOnce()
    expect(server.publishExecutionObservation(PANE, first)).toBe(false)
    expect(server.publishExecutionObservation(PANE, second)).toBe(true)
    expect(server.getStatusSnapshot()[0]?.executionObservation?.captureRevision).toBe(2)
    const delta = frames
      .toReversed()
      .find(
        (frame): frame is { type: 'delta'; changes: { type: string; row?: unknown }[] } =>
          typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'delta'
      )
    expect(delta?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'set',
          row: expect.objectContaining({
            executionObservation: expect.objectContaining({ captureRevision: 2 })
          })
        })
      ])
    )
    unsubscribe()
    publisher.dispose()
  })

  it('does not create a status row for an attachment that is no longer present', () => {
    const server = new AgentHookServer()
    const observation = {
      executionId: 'exec-1',
      hostId: 'local' as const,
      hostEpoch: 'epoch-1',
      captureRevision: 1,
      observedAt: 1_000,
      inventoryCoverage: 'partial' as const,
      verdict: 'unverifiable' as const
    }
    expect(server.publishExecutionObservation(PANE, observation)).toBe(false)
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('rejects a changed attachment binding or host identity', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      { paneKey: PANE, payload: { state: 'working', agentType: 'codex' } },
      'conn-1'
    )
    const first = {
      executionId: 'exec-1',
      runId: 'run-1',
      role: 'root' as const,
      hostId: 'local' as const,
      hostEpoch: 'epoch-1',
      captureRevision: 1,
      observedAt: 1_000,
      inventoryCoverage: 'complete' as const,
      verdict: 'live' as const
    }
    expect(server.publishExecutionObservation(PANE, first)).toBe(true)
    expect(server.publishExecutionObservation(PANE, { ...first, runId: 'run-2' })).toBe(false)
    expect(server.publishExecutionObservation(PANE, { ...first, hostId: 'ssh:target' })).toBe(false)
    expect(server.getStatusSnapshot()[0]?.executionObservation).toEqual(first)
  })

  it('accepts a replacement only when the host supplies the exact attachment proof', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      { paneKey: PANE, payload: { state: 'working', agentType: 'codex' } },
      'conn-1'
    )
    const oldObservation = {
      executionId: 'exec-old',
      runId: 'run-old',
      role: 'root' as const,
      hostId: 'local' as const,
      hostEpoch: 'epoch-1',
      captureRevision: 1,
      observedAt: 1_000,
      inventoryCoverage: 'complete' as const,
      verdict: 'live' as const
    }
    const replacement = {
      ...oldObservation,
      executionId: 'exec-new',
      runId: 'run-new',
      captureRevision: 1
    }
    expect(server.publishExecutionObservation(PANE, oldObservation)).toBe(true)
    expect(
      server.publishExecutionObservation(PANE, replacement, {
        executionId: 'exec-new',
        runId: 'run-new',
        role: 'root',
        hostId: 'local',
        hostEpoch: 'epoch-1',
        paneKey: PANE
      })
    ).toBe(true)
    expect(server.getStatusSnapshot()[0]?.executionObservation).toEqual(replacement)
    expect(
      server.publishExecutionObservation(
        PANE,
        { ...replacement, captureRevision: 2 },
        {
          executionId: 'exec-new',
          runId: 'run-new',
          role: 'root',
          hostId: 'local',
          hostEpoch: 'epoch-1',
          paneKey: PANE
        }
      )
    ).toBe(true)
    expect(server.getStatusSnapshot()[0]?.executionObservation?.captureRevision).toBe(2)
  })
})
