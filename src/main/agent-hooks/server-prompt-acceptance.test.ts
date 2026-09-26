import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { PANE, buildBody } from './server.test-fixtures'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))
vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function ingestCodex(
  server: AgentHookServer,
  hookEventName: string,
  extra: { providerPromptId?: string; toolAgentId?: string; isReplay?: boolean } = {}
): void {
  server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      source: 'codex',
      hookEventName,
      ...extra,
      payload: { state: 'working', prompt: 'brief', agentType: 'codex' }
    },
    'conn-1'
  )
}

function promptAcceptance(server: AgentHookServer) {
  return server.getStatusSnapshot().find((row) => row.paneKey === PANE)?.promptAcceptance
}

describe('prompt acceptance on the hook store row', () => {
  it("normalizes Codex's turn_id as the provider turn identity", () => {
    const event = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'brief', turn_id: 'turn-7' }),
      'production'
    )
    expect(event?.providerPromptId).toBe('turn-7')
  })

  it('records no acceptance for a session start, only for the prompt submission', () => {
    vi.useFakeTimers({ now: 1_000 })
    const server = new AgentHookServer()

    ingestCodex(server, 'SessionStart')
    expect(promptAcceptance(server)).toBeUndefined()

    vi.setSystemTime(2_000)
    ingestCodex(server, 'UserPromptSubmit', { providerPromptId: 'turn-7' })
    expect(promptAcceptance(server)).toEqual({ acceptedAt: 2_000, providerTurnId: 'turn-7' })

    // Later turn events restate it; they never move it.
    vi.setSystemTime(3_000)
    ingestCodex(server, 'PreToolUse', { providerPromptId: 'turn-7' })
    expect(promptAcceptance(server)).toEqual({ acceptedAt: 2_000, providerTurnId: 'turn-7' })
  })

  it('records acceptance without a turn id from a relay that does not send one', () => {
    vi.useFakeTimers({ now: 5_000 })
    const server = new AgentHookServer()

    ingestCodex(server, 'UserPromptSubmit')

    expect(promptAcceptance(server)).toEqual({ acceptedAt: 5_000 })
  })

  it("ignores a child's prompt submission and a relay replay", () => {
    vi.useFakeTimers({ now: 1_000 })
    const server = new AgentHookServer()

    ingestCodex(server, 'UserPromptSubmit', { toolAgentId: 'child-1' })
    expect(promptAcceptance(server)).toBeUndefined()

    vi.setSystemTime(2_000)
    ingestCodex(server, 'UserPromptSubmit', { isReplay: true })
    expect(promptAcceptance(server)).toBeUndefined()
  })
})
