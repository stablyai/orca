import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookSource } from '../../../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))
vi.mock('../../../../telemetry/client', () => ({ track: trackMock }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})
afterEach(() => vi.restoreAllMocks())

function reviveRetiredPane(source: unknown, hookEventName: string): boolean {
  const server = new AgentHookServer()
  server.retirePaneAuthority(PANE)
  server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      ...(source === undefined ? {} : { source }),
      hookEventName,
      payload: {
        state: 'working',
        prompt: 'after reuse',
        agentType: typeof source === 'string' ? source : 'claude'
      }
    },
    'conn-1'
  )
  return server.getStatusSnapshot().some((entry) => entry.paneKey === PANE)
}

describe("retired pane un-retires on each provider's own new-turn event", () => {
  it('revives on a literal boundary when an older relay omits source', () => {
    expect(reviveRetiredPane(undefined, 'UserPromptSubmit')).toBe(true)
  })

  it('cannot revive a non-literal provider when an older relay omits source', () => {
    // Source-less legacy peers intentionally recognize only literal compatibility boundaries.
    expect(reviveRetiredPane(undefined, 'before_agent_start')).toBe(false)
  })

  it('revives on any event from a provider this build does not recognize', () => {
    // Why fail open: a newer host can relay a 19th provider whose boundary name is unknown here.
    // `isAgentHookSource` rejects it, so it must not fall through to the legacy literals and
    // strand the pane permanently.
    expect(reviveRetiredPane('future-provider-19' as AgentHookSource, 'SomethingNewEntirely')).toBe(
      true
    )
  })

  it.each([null, '', 19, { provider: 'future-provider-19' }])(
    'keeps malformed source value %j behind the retired-pane fence',
    (source) => {
      expect(
        reviveRetiredPane(source, source === null ? 'SessionStart' : 'SomethingNewEntirely')
      ).toBe(false)
    }
  )

  it('leaves the pane retired for a source with no turn boundary', () => {
    // These providers lack classifier boundaries; mimo-code explicit prompts are covered by lifecycle tests.
    expect(reviveRetiredPane('mimo-code', 'SessionStart')).toBe(false)
    expect(reviveRetiredPane('command-code', 'SessionStart')).toBe(false)
  })

  it('leaves the pane retired for a non-boundary event on a revivable source', () => {
    expect(reviveRetiredPane('gemini', 'AfterAgent')).toBe(false)
  })
})
