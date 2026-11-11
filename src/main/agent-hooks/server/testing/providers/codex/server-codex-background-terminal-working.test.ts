import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS } from '../../../program-status/hook-precedence'
import { buildBody, ingestProgramStatusOsc, postHookEvent } from '../../server.test-fixtures'

const TURN = { session_id: 'session-1', turn_id: 'turn-1' }

let server: AgentHookServer

beforeEach(async () => {
  server = new AgentHookServer()
  await server.start({ env: 'production' })
})

afterEach(() => {
  vi.useRealTimers()
  server.stop()
})

async function codexHook(hookEventName: string, payload: Record<string, unknown> = {}) {
  const response = await postHookEvent(
    server,
    buildBody({ ...TURN, hook_event_name: hookEventName, ...payload }),
    '/hook/codex'
  )
  expect(response.status).toBe(204)
}

it('keeps a finished Codex turn done while its background terminal keeps OSC 7501 working', async () => {
  await codexHook('UserPromptSubmit', { prompt: 'start sleep 900 in the background' })
  // Codex 0.167 sends this at the turn start and nothing after it while `sleep 900` runs.
  const working = ingestProgramStatusOsc(server, '\x1b]7501;state=working:app=codex\x1b\\')
  await codexHook('Stop', { last_assistant_message: 'ok' })

  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  server.ingestTerminalStatus({ ...working, renewsProgramStatusLease: true })
  vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)

  expect(server.getStatusSnapshot()[0]?.state).toBe('done')
})
