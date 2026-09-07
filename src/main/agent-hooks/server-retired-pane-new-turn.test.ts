import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))
vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})
afterEach(() => vi.restoreAllMocks())

/** Each source's own new-turn boundary, as `isNewTurnEvent` classifies it. `null` means the
 *  classifier names no boundary for that source. That is not the same as "can never revive":
 *  mimo-code's boundary is an explicit-prompt MessagePart, which the gate handles separately. */
const NEW_TURN_EVENT: Record<AgentHookSource, string | null> = {
  claude: 'SessionStart',
  kimi: 'UserPromptSubmit',
  codex: 'SessionStart',
  gemini: 'BeforeAgent',
  antigravity: 'PreInvocation',
  amp: 'agent.start',
  cursor: 'beforeSubmitPrompt',
  pi: 'before_agent_start',
  omp: 'before_agent_start',
  'prime-agent': 'before_agent_start',
  droid: 'UserPromptSubmit',
  grok: 'user_prompt_submit',
  copilot: 'sessionStart',
  hermes: 'pre_llm_call',
  devin: 'UserPromptSubmit',
  opencode: 'SessionStart',
  'mimo-code': null,
  'command-code': null
}

function reviveRetiredPane(source: unknown, hookEventName: string): boolean {
  const server = new AgentHookServer()
  // Why: retirement is what command completion leaves behind on a reusable shell pane.
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
  // Why: the gate matched two raw literals, so only the 5 sources that happen to name their
  // boundary UserPromptSubmit/SessionStart could ever revive — the rest stayed rowless forever.
  // Why: keys of a Record<AgentHookSource, …> — a new source fails typecheck here rather than
  // silently skipping coverage, which is the same guarantee the runtime list would give.
  const revivable = (Object.keys(NEW_TURN_EVENT) as AgentHookSource[]).filter(
    (source) => NEW_TURN_EVENT[source] !== null
  )

  it.each(revivable)('%s', (source) => {
    const hookEventName = NEW_TURN_EVENT[source]
    expect(hookEventName).not.toBeNull()
    expect(reviveRetiredPane(source, hookEventName as string)).toBe(true)
  })

  // Why these two: every case above passes `source`, so the source-less compatibility path —
  // the branch added for older relays — would otherwise ship with no coverage at all.
  it('revives on a literal boundary when an older relay omits source', () => {
    expect(reviveRetiredPane(undefined, 'UserPromptSubmit')).toBe(true)
  })

  it('cannot revive a non-literal provider when an older relay omits source', () => {
    // Why pinned: this is the accepted cost of the legacy shim, not an oversight. Widening the
    // literal list to "fix" it would re-create the two-literal gate this change removes.
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
    // Why mimo-code and command-code: neither names a boundary through `isNewTurnEvent`, so
    // SessionStart must not open the gate for them. Mimo-code still revives on its own
    // explicit-prompt MessagePart — that path is covered in server-opencode-lifecycle.test.ts.
    expect(reviveRetiredPane('mimo-code', 'SessionStart')).toBe(false)
    expect(reviveRetiredPane('command-code', 'SessionStart')).toBe(false)
  })

  it('leaves the pane retired for a non-boundary event on a revivable source', () => {
    // Why: guards the inverse — the gate must not open on any event that merely mentions a session.
    expect(reviveRetiredPane('gemini', 'AfterAgent')).toBe(false)
  })
})
