import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { createHookListenerState } from '../../../../../../shared/agent-hook-listener/listener-state'
import { buildRelayHookEnvelope } from '../../../../../../wsl-guest/agent-hook-envelope-build'
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
const reply = (index: number) => ({
  hook_event_name: 'UserPromptSubmit',
  turn_id: 'turn-1',
  prompt: `<send_user_message_question_reply>\n${JSON.stringify([
    {
      answer: 'SQLite',
      question: QUESTIONS.questions[index]!.title,
      questionItemId: JSON.stringify(['request_user_input_async', 'call_3_1', index])
    }
  ])}\n</send_user_message_question_reply>`
})

beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// The execution host normalizes each hook, then main ingests the relayed row, as for SSH and WSL.
function codexPane() {
  const host = createHookListenerState()
  const server = new AgentHookServer()
  return {
    report(payload: Record<string, unknown>) {
      const event = normalizeHookPayload(
        host,
        'codex',
        buildBody(payload, { worktreeId: 'folder-workspace' }),
        'production'
      )
      if (!event) {
        throw new Error('Expected a Codex hook event')
      }
      server.ingestRemote(buildRelayHookEnvelope(event, 'codex'), 'wsl:Ubuntu')
      return { host: event.payload, main: server.getStatusSnapshotForPane(PANE)[0] }
    }
  }
}

const waitingOnQuestion = {
  state: 'waiting',
  toolName: 'request_user_input_async',
  interactivePrompt: JSON.stringify(QUESTIONS)
}

describe('Codex async questions', () => {
  it('waits on an open question through the turn until every question is answered', () => {
    const pane = codexPane()
    pane.report({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'Set up a db' })

    expect(pane.report(ASK).main).toMatchObject(waitingOnQuestion)
    // Codex accepts the call at once and keeps working; the question is still open.
    const accepted = pane.report(ACCEPTED)
    expect(accepted.host).toMatchObject(waitingOnQuestion)
    expect(accepted.main).toMatchObject(waitingOnQuestion)
    pane.report({ hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash' })
    // An approval on screen wins over the open question.
    const approval = pane.report({
      hook_event_name: 'PermissionRequest',
      turn_id: 'turn-1',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm tc' }
    }).main
    expect(approval?.state).toBe('waiting')
    expect(approval?.interactivePrompt).toContain('"approval"')
    pane.report({ hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'Bash' })
    expect(pane.report(reply(0)).main).toMatchObject(waitingOnQuestion)

    const answered = pane.report(reply(1)).main
    expect(answered).toMatchObject({ state: 'working' })
    expect(answered?.interactivePrompt).toBeUndefined()
  })

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
