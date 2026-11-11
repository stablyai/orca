import { afterEach, expect, it, vi } from 'vitest'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import type { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_CODEX_QUESTION_SKIP_METHODS } from './methods/terminal/terminal-codex-question-skip-method'

const PANE = 'tab:11111111-1111-4111-8111-111111111111'

afterEach(() => {
  vi.restoreAllMocks()
})

function dispatch(paneKey: string | null) {
  const overrides: Partial<OrcaRuntimeService> = {
    getRuntimeId: () => 'test-runtime',
    getLiveTerminalPaneKey: () => paneKey
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this scoped dispatcher reaches only the runtime methods defined above.
  const runtime = overrides as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: TERMINAL_CODEX_QUESTION_SKIP_METHODS }).dispatch({
    id: 'request',
    authToken: 'token',
    method: 'terminal.inferCodexQuestionSkip',
    params: { terminal: 'terminal', prompt: 'Set up a db' }
  })
}

it("applies a desktop's skip keystroke to this host's pane as a Codex skip", async () => {
  const infer = vi.spyOn(agentHookServer, 'inferQuestionAnswered').mockReturnValue(true)
  expect(await dispatch(PANE)).toMatchObject({ ok: true, result: { applied: true } })
  expect(infer).toHaveBeenCalledWith(
    expect.objectContaining({ paneKey: PANE, baselinePrompt: 'Set up a db', codexSkip: true })
  )
})

it('refuses a handle that names no live pane on this host', async () => {
  const infer = vi.spyOn(agentHookServer, 'inferQuestionAnswered')
  expect(await dispatch(null)).toMatchObject({ ok: true, result: { applied: false } })
  expect(infer).not.toHaveBeenCalled()
})
