import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkLiveEvidence
} from '../../../shared/agent-status-child-work-evidence'
import { makeStructuredAgentStatusSubject } from '../../../shared/agent-status-subject'
import { AgentHookServer } from '../../agent-hooks/server'
import { StructuredAgentSessionStatusOwnership } from './structured-agent-session-status-ownership'

const location: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'folder-workspace',
  workspaceKind: 'folder'
}
const summary: AgentSessionStatusSummary = {
  sessionId: 'structured-session',
  workspaceId: location.workspaceId,
  agent: 'codex',
  status: 'working',
  latestPrompt: 'fixture',
  updatedAt: 100
}

describe('structured status owner address retention', () => {
  it('retains scope through record deletion and does not resurrect after forget', () => {
    const sink = { publish: vi.fn(), forget: vi.fn() }
    const owner = new StructuredAgentSessionStatusOwnership(() => sink)
    const subject = makeStructuredAgentStatusSubject(location, summary.sessionId)
    owner.publish(summary, location)
    owner.publish({ ...summary, hostExecutionOwned: undefined })
    expect(sink.publish).toHaveBeenLastCalledWith(summary, subject)
    owner.forget(summary.sessionId)
    expect(sink.forget).toHaveBeenCalledExactlyOnceWith(subject)
    owner.publish(summary)
    owner.forget(summary.sessionId)
    expect(sink.publish).toHaveBeenCalledTimes(2)
    expect(sink.forget).toHaveBeenCalledOnce()
  })

  it('forgets the old exact scope before publishing a trusted location change', () => {
    const sink = { publish: vi.fn(), forget: vi.fn() }
    const owner = new StructuredAgentSessionStatusOwnership(() => sink)
    owner.publish(summary, location)
    const replacement = { ...location, executionHostId: 'ssh:second-host' as const }
    owner.publish(summary, replacement)
    expect(sink.forget).toHaveBeenCalledExactlyOnceWith(
      makeStructuredAgentStatusSubject(location, summary.sessionId)
    )
    expect(sink.forget.mock.invocationCallOrder[0]).toBeLessThan(
      sink.publish.mock.invocationCallOrder[1]
    )
    owner.forget(summary.sessionId)
    expect(sink.forget).toHaveBeenLastCalledWith(
      makeStructuredAgentStatusSubject(replacement, summary.sessionId)
    )
  })

  it('does not report a throwing publication as an owned location', () => {
    const sink = {
      publish: vi.fn().mockImplementationOnce(() => {
        throw new Error('store down')
      }),
      forget: vi.fn()
    }
    const owner = new StructuredAgentSessionStatusOwnership(() => sink)
    expect(() => owner.publish(summary, location)).toThrow('store down')
    // Failed publication must not establish location proof or suppress a later re-offer.
    expect(owner.matchesLocation(summary.sessionId, location)).toBe(false)
    owner.publish(summary, location)
    expect(sink.publish).toHaveBeenCalledTimes(2)
    expect(owner.matchesLocation(summary.sessionId, location)).toBe(true)
  })

  it('keeps the owner address when a downstream publication observer throws', () => {
    const sink = {
      publish: vi.fn(() => {
        throw new Error('observer failed')
      }),
      forget: vi.fn()
    }
    const owner = new StructuredAgentSessionStatusOwnership(() => sink)
    expect(() => owner.publish(summary, location)).toThrow('observer failed')
    owner.forget(summary.sessionId)
    expect(sink.forget).toHaveBeenCalledExactlyOnceWith(
      makeStructuredAgentStatusSubject(location, summary.sessionId)
    )
  })

  it('does not fabricate location for an unknown session or an unavailable sink', () => {
    const sink = { publish: vi.fn(), forget: vi.fn() }
    const owner = new StructuredAgentSessionStatusOwnership(() => sink)
    owner.publish(summary)
    expect(sink.publish).not.toHaveBeenCalled()
    const unavailable = new StructuredAgentSessionStatusOwnership(() => undefined)
    expect(() => unavailable.publish(summary, location)).not.toThrow()
    expect(() => unavailable.forget(summary.sessionId)).not.toThrow()
  })

  it('offers child work only under the address its parent row landed under', () => {
    const sink = { publish: vi.fn(), forget: vi.fn(), publishChildWork: vi.fn() }
    const owner = new StructuredAgentSessionStatusOwnership(() => sink)
    const subject = makeStructuredAgentStatusSubject(location, summary.sessionId)
    const evidence = [{ type: 'session-ended' as const, observedAt: 1 }]
    owner.publishChildWork(summary.sessionId, evidence, 'claude')
    expect(sink.publishChildWork).not.toHaveBeenCalled()
    owner.publish(summary, location)
    owner.publishChildWork(summary.sessionId, evidence, 'claude')
    expect(sink.publishChildWork).toHaveBeenCalledExactlyOnceWith(subject, evidence, 'claude')
    owner.forget(summary.sessionId)
    owner.publishChildWork(summary.sessionId, evidence, 'claude')
    expect(sink.publishChildWork).toHaveBeenCalledOnce()
    const unlanded = new StructuredAgentSessionStatusOwnership(() => ({
      ...sink,
      publish: () => {
        throw new Error('store down')
      }
    }))
    expect(() => unlanded.publish(summary, location)).toThrow('store down')
    unlanded.publishChildWork(summary.sessionId, evidence, 'claude')
    expect(sink.publishChildWork).toHaveBeenCalledOnce()
  })
})

describe('child work the provider reported, recorded or not', () => {
  const agentLive = (id: string, runId?: string): AgentChildWorkLiveEvidence => ({
    type: 'live',
    observedAt: 200,
    child: {
      handle: { idKind: 'task_id', id, ...(runId ? { runId } : {}) },
      kind: 'agent',
      residency: 'background',
      state: 'working',
      stoppable: true
    }
  })

  function owners(refuse?: () => boolean) {
    const server = new AgentHookServer()
    const owner = new StructuredAgentSessionStatusOwnership(() => ({
      publish: (published, subject) => server.ingestStructuredStatus(published, subject),
      forget: (subject) => server.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) =>
        refuse?.() ? null : server.ingestStructuredChildWork(subject, evidence, provider),
      readChildWork: (subject) => server.getStructuredChildWorkViews(subject),
      readChildWorkRecords: (subject) => server.getStructuredChildWork(subject),
      readChildWorkHandles: (subject) => server.getStructuredChildWorkHandles(subject)
    }))
    return { owner }
  }

  const ended = (id: string): AgentChildWorkEvidence => ({
    type: 'ended',
    observedAt: 250,
    handle: { idKind: 'task_id', id },
    outcome: 'succeeded'
  })

  function refusingStore() {
    let refusing = true
    const { owner } = owners(() => refusing)
    owner.publish({ ...summary, status: 'idle' }, location)
    return {
      owner,
      admit: () => {
        refusing = false
      }
    }
  }

  it('marks an idle parent incomplete when the store refuses its live background child', () => {
    const { owner } = refusingStore()
    owner.publishChildWork(summary.sessionId, [agentLive('background-agent')], 'claude')

    expect(owner.readChildWork(summary.sessionId)).toEqual([])
    expect(owner.childWorkIncomplete(summary.sessionId)).toBe(true)
    owner.publishChildWork(summary.sessionId, [agentLive('background-agent')], 'claude')
    expect(owner.childWorkIncomplete(summary.sessionId)).toBe(true)
    owner.publishChildWork(
      summary.sessionId,
      [{ type: 'session-ended', observedAt: 300 }],
      'claude'
    )
    expect(owner.childWorkIncomplete(summary.sessionId)).toBe(false)
  })

  it('is whole again once the refused child is admitted on a later report', () => {
    const { owner, admit } = refusingStore()
    owner.publishChildWork(summary.sessionId, [agentLive('background-agent')], 'claude')
    expect(owner.childWorkIncomplete(summary.sessionId)).toBe(true)
    admit()
    owner.publishChildWork(summary.sessionId, [agentLive('background-agent')], 'claude')
    expect(owner.readChildWork(summary.sessionId)).toHaveLength(1)
    expect(owner.childWorkIncomplete(summary.sessionId)).toBe(false)
  })

  it('is whole again once every refused child reports its own end', () => {
    const { owner } = refusingStore()
    owner.publishChildWork(summary.sessionId, [agentLive('first'), agentLive('second')], 'claude')
    owner.publishChildWork(summary.sessionId, [ended('first')], 'claude')
    expect(owner.childWorkIncomplete(summary.sessionId)).toBe(true)
    owner.publishChildWork(summary.sessionId, [ended('second')], 'claude')
    expect(owner.childWorkIncomplete(summary.sessionId)).toBe(false)
    expect(owner.childWorkOpen(summary.sessionId)).toBe(false)
  })

  it('holds recorded work open, never incomplete, through a late ending of its earlier run', () => {
    const { owner } = owners()
    owner.publish(summary, location)
    const run = (runId: string): AgentChildWorkEvidence => ({
      type: 'live',
      observedAt: 200,
      child: {
        handle: { idKind: 'task_id', id: 'helper', runId },
        kind: 'agent',
        residency: 'background',
        state: 'working',
        stoppable: true
      }
    })
    const endOf = (runId: string): AgentChildWorkEvidence => ({
      type: 'ended',
      observedAt: 250,
      handle: { idKind: 'task_id', id: 'helper', runId },
      outcome: 'succeeded'
    })
    owner.publishChildWork(summary.sessionId, [run('spawn-1'), endOf('spawn-1')], 'claude')
    owner.publishChildWork(summary.sessionId, [run('spawn-2')], 'claude')
    owner.publishChildWork(summary.sessionId, [run('spawn-1'), endOf('spawn-1')], 'claude')
    expect(owner.childWorkOpen(summary.sessionId)).toBe(true)
    expect(owner.childWorkIncomplete(summary.sessionId)).toBe(false)
    owner.publishChildWork(summary.sessionId, [endOf('spawn-2')], 'claude')
    expect(owner.childWorkOpen(summary.sessionId)).toBe(false)
    owner.publishChildWork(summary.sessionId, [run('spawn-3'), run('spawn-4')], 'claude')
    owner.publishChildWork(summary.sessionId, [endOf('spawn-3')], 'claude')
    expect(owner.childWorkOpen(summary.sessionId)).toBe(true)
    owner.publishChildWork(summary.sessionId, [endOf('spawn-4')], 'claude')
    expect(owner.childWorkOpen(summary.sessionId)).toBe(false)
  })

  it('does not treat an idle ACP row as coverage of newly reported work', () => {
    let refuse = false
    const { owner } = owners(() => refuse)
    owner.publish(summary, location)
    const report = (state: 'working' | 'idle'): AgentChildWorkEvidence => ({
      type: 'live',
      observedAt: 200,
      child: {
        handle: { idKind: 'task_id', id: 'acp-task:helper' },
        kind: 'command',
        residency: 'background',
        state,
        stoppable: true
      }
    })
    owner.publishChildWork(summary.sessionId, [report('working'), report('idle')], 'grok')
    refuse = true
    owner.publishChildWork(summary.sessionId, [report('working')], 'grok')
    refuse = false
    expect(owner.childWorkOpen(summary.sessionId)).toBe(true)
    expect(owner.childWorkIncomplete(summary.sessionId)).toBe(true)
    owner.publishChildWork(summary.sessionId, [report('working')], 'grok')
    expect(owner.childWorkIncomplete(summary.sessionId)).toBe(false)
  })

  it('closes only the captured Stop lifetime and reads a later live report as unlisted', () => {
    const { owner } = owners()
    owner.publish(summary, location)
    owner.publishChildWork(summary.sessionId, [agentLive('helper')], 'claude')
    const captured = owner.captureChildWorkStops(summary.sessionId, ['helper'])
    const [record] = owner.readChildWorkRecords(summary.sessionId)!
    const stop: AgentChildWorkEvidence = {
      type: 'stop-acknowledged',
      observedAt: 260,
      childWorkId: record!.childWorkId,
      handleId: 'helper',
      invocation: record!.invocation
    }
    captured.acknowledge([stop])
    owner.publishChildWork(summary.sessionId, [stop], 'claude')
    expect(owner.childWorkOpen(summary.sessionId)).toBe(false)
    // Failed Stop leaves live work outside the store’s settled display record.
    owner.publishChildWork(summary.sessionId, [agentLive('helper', 'new-run')], 'claude')
    expect(owner.childWorkOpen(summary.sessionId)).toBe(true)
    expect(owner.childWorkIncomplete(summary.sessionId)).toBe(true)
    expect(captured.current('helper')).toBe(false)
  })
})
