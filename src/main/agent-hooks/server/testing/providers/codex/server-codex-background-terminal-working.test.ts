import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS } from '../../../program-status/hook-precedence'
import { PANE, buildBody, ingestProgramStatusOsc, postHookEvent } from '../../server.test-fixtures'

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

it.each([
  // Captured Codex 0.163 idle (orca-runtime-codex-idle-title-chat-address.test.ts).
  '\x1b]7501;state=idle:app=codex\x1b\\',
  // Captured Codex 0.167 working, above.
  '\x1b]7501;state=working:app=codex\x1b\\'
])('counts genuine parsed OSC progress but not renewal or deferred replay: %j', async (osc) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_790_000_000_000)
  await codexHook('UserPromptSubmit', { prompt: 'start sleep 900 in the background' })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(1_790_000_001_000)
  const report = ingestProgramStatusOsc(server, osc)
  expect(server.producerProgress.get(PANE)?.lastProducerEventAt).toBe(1_790_000_001_000)
  expect(server.getStatusSnapshotForPane(PANE)[0]?.state).toBe('working')
  vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
  expect(server.producerProgress.get(PANE)?.lastProducerEventAt).toBe(1_790_000_001_000)
  server.ingestTerminalStatus({ ...report, renewsProgramStatusLease: true })
  expect(server.producerProgress.get(PANE)?.lastProducerEventAt).toBe(1_790_000_001_000)
  vi.advanceTimersByTime(1_000)
  ingestProgramStatusOsc(server, osc)
  expect(server.producerProgress.get(PANE)?.lastProducerEventAt).toBe(1_790_000_122_001)
})

vi.mock('../../../../../foreign-sqlite-readers/foreign-sqlite-reader-spawn', () => ({
  readOpenCodeBinderSessions: async () => []
}))
