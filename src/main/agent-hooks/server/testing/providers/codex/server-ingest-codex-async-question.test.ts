import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../../agent-hook-server'
import { PANE, buildBody, postHookEvent } from '../../server.test-fixtures'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

// Shapes captured from a live Codex 0.166 run.
const QUESTIONS = {
  questions: [
    { title: 'Which database should the probe use?', options: ['Postgres', 'SQLite', 'MySQL'] },
    { title: 'What should the probe name the new table?' }
  ]
}
const ASK = {
  hook_event_name: 'PreToolUse',
  turn_id: 'turn-1',
  tool_name: 'request_user_input_async',
  tool_input: QUESTIONS,
  tool_use_id: 'call_3_1'
}
const ACCEPTED = {
  ...ASK,
  hook_event_name: 'PostToolUse',
  tool_response: '{"accepted":true}'
}
beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const waitingOnQuestion = {
  state: 'waiting',
  toolName: 'request_user_input_async',
  interactivePrompt: JSON.stringify(QUESTIONS)
}

describe('Codex async questions', () => {
  it('drops one question per skip keystroke on a local pane, since Codex reports no skip', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const row = () => server.getStatusSnapshotForPane(PANE)[0]!
    const post = async (payload: Record<string, unknown>) => {
      await postHookEvent(server, buildBody(payload), '/hook/codex')
      return row()
    }
    const baselineOf = (baseline: {
      receivedAt: number
      stateStartedAt: number
      prompt: string
    }) => ({
      paneKey: PANE,
      baselineUpdatedAt: baseline.receivedAt,
      baselineStateStartedAt: baseline.stateStartedAt,
      baselinePrompt: baseline.prompt,
      baselineAgentType: 'codex' as const
    })
    const skip = (baseline: { receivedAt: number; stateStartedAt: number; prompt: string }) =>
      server.inferQuestionAnswered({ ...baselineOf(baseline), codexSkip: true })
    try {
      await post({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'Set up a db' })
      await post(ASK)
      expect(await post(ACCEPTED)).toMatchObject(waitingOnQuestion)

      // An answer inference (e.g. Enter sent over RPC) is not a skip.
      expect(server.inferQuestionAnswered(baselineOf(row()))).toBe(false)
      // Two quick skips share the renderer's stale baseline; both must land.
      const stale = row()
      expect(skip(stale)).toBe(true)
      expect(row()).toMatchObject(waitingOnQuestion)
      expect(skip(stale)).toBe(true)
      expect(row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      expect(row().interactivePrompt).toBeUndefined()
      // Later hooks in the same turn must not resurrect the skipped question.
      const bash = { hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash' }
      expect(await post(bash)).toMatchObject({ state: 'working' })
      expect(skip(row())).toBe(false)
    } finally {
      server.stop()
    }
  })
})
