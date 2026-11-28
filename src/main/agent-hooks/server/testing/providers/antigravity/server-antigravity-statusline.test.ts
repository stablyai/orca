import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { PANE } from '../../server.test-fixtures'
import type { AntigravityStatusLineReading } from '../../../../../../shared/agent-usage/rate-limits/antigravity-statusline-quota'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const PAYLOAD = JSON.stringify({
  email: 'someone@example.com',
  quota: {
    'gemini-5h': { remaining_fraction: 0.25, reset_time: '2999-01-01T00:00:00Z' },
    'gemini-weekly': { remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' }
  }
})

let root: string
let server: AgentHookServer
const readings: AntigravityStatusLineReading[] = []

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-agy-statusline-'))
  readings.length = 0
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: join(root, 'orca') })
  server.setAntigravityStatusLineListener((reading) => readings.push(reading))
})

afterEach(() => {
  server.stop()
  rmSync(root, { recursive: true, force: true })
})

function post(token: string, payload = PAYLOAD): Promise<Response> {
  const env = server.buildPtyEnv()
  return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/statusline/antigravity`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Connection: 'close',
      'X-Orca-Agent-Hook-Token': token
    },
    body: new URLSearchParams({ paneKey: PANE, payload })
  })
}

it('hands a status-line quota post to the listener with the email and windows', async () => {
  const response = await post(server.buildPtyEnv().ORCA_AGENT_HOOK_TOKEN)
  expect(response.status).toBe(204)
  expect(readings).toHaveLength(1)
  expect(readings[0].email).toBe('someone@example.com')
  expect(readings[0].limits.session?.usedPercent).toBe(75)
  expect(readings[0].limits.weekly).toMatchObject({ usedPercent: 0, resetsAt: null })
})

it('answers 204 but reports nothing for a post without quota windows', async () => {
  const response = await post(server.buildPtyEnv().ORCA_AGENT_HOOK_TOKEN, '{"email":"a@b.c"}')
  expect(response.status).toBe(204)
  expect(readings).toHaveLength(0)
})

it('rejects a post with the wrong token', async () => {
  const response = await post('not-the-token')
  expect(response.status).not.toBe(204)
  expect(readings).toHaveLength(0)
})
