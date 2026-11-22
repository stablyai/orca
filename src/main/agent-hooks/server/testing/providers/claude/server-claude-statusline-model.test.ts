import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
let root: string
let server: AgentHookServer

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-statusline-model-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: join(root, 'orca') })
})

afterEach(() => {
  server.stop()
  rmSync(root, { recursive: true, force: true })
})

async function hook(payload: Record<string, unknown>): Promise<void> {
  const response = await postHookEvent(server, buildBody({ session_id: SESSION, ...payload }))
  expect(response.status).toBe(204)
}

/** The form the managed statusline script posts, with the fields Claude 2.1.330 sends. */
async function statusLine(sessionId: string, modelId: string): Promise<void> {
  const env = server.buildPtyEnv()
  const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/statusline/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Connection: 'close',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: new URLSearchParams({
      paneKey: PANE,
      payload: JSON.stringify({
        session_id: sessionId,
        model: { id: modelId, display_name: 'Model' },
        rate_limits: { five_hour: { used_percentage: 1 } }
      })
    })
  })
  expect(response.status).toBe(204)
}

const model = (): string | undefined =>
  server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)?.model

it('follows a /model switch that Claude reports only on its statusline', async () => {
  await hook({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' })
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
  expect(model()).toBe('claude-opus-5-5')

  const emitted: (string | undefined)[] = []
  server.subscribeEnrichedStatus((row) => emitted.push(row.payload.model))
  await statusLine(OTHER_SESSION, 'claude-haiku-5-5')
  await statusLine(SESSION, 'claude-opus-5-5')
  expect(model()).toBe('claude-opus-5-5')

  await statusLine(SESSION, 'claude-fable-5-2')
  await statusLine(SESSION, 'claude-fable-5-2')
  expect(model()).toBe('claude-fable-5-2')
  // Statusline ticks with an unchanged model must not fan out to phones.
  expect(emitted).toEqual(['claude-fable-5-2'])

  // Later hooks carry no model; they must not bring the start model back.
  await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} })
  expect(model()).toBe('claude-fable-5-2')
})
