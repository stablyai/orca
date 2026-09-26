import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { makeStructuredAgentStatusSubject } from '../../../shared/agent-status-subject'
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
    // The feed skips an unchanged re-projection only when the location already matches. Reporting a
    // match here would strand the row: the publish never landed and nothing else re-offers it.
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
    // An address held after a publish that threw is not a row that landed.
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
