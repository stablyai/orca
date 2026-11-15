import { RuntimeClient } from '../../runtime/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ORCHESTRATION_SEND_HANDLER } from './message-send-handler'

const exitCode = process.exitCode
const call = vi.fn()
let lines: string[]

beforeEach(() => {
  call.mockReset()
  lines = []
  vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)))
  vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
  vi.stubEnv('ORCA_STRUCTURED_SESSION', undefined)
  process.exitCode = 0
})
afterEach(() => {
  process.exitCode = exitCode ?? 0
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const receipt = {
  message: { id: 'msg-held' },
  delivered: false,
  state: 'held',
  reason: { kind: 'worker_failed', failure: 'network' },
  failureId: 'failure-77',
  target: { sessionId: 'worker-1', dispatchId: 'dispatch-4' },
  waiting: 2,
  deliveryMessage:
    "Held, not delivered: Worker stopped after a network error. Delivers when it's resumed.",
  deliveryHint:
    'Resume once: orca orchestration send --to dispatch:dispatch-4 --resume --failure-id failure-77'
}

async function send(extra: [string, string | boolean][] = [], json = false) {
  const client = new RuntimeClient('/tmp/idle-worker-cli-test', 10000, null, null, 'orca')
  vi.spyOn(client, 'call').mockImplementation(call)
  return ORCHESTRATION_SEND_HANDLER['orchestration send']!({
    flags: new Map<string, string | boolean>([
      ['from', 'coordinator'],
      ['to', 'dispatch:dispatch-4'],
      ['subject', 'continue'],
      ...extra
    ]),
    client,
    cwd: '/tmp',
    json
  })
}

it.each([false, true])(
  'reports a kept failure as non-delivery in text, including full=%s',
  async (full) => {
    call.mockResolvedValue({ ok: true, result: receipt })
    await send(full ? [['full', true]] : [])
    expect(process.exitCode).toBe(1)
    expect(lines).toEqual([
      "Held, not delivered: Worker stopped after a network error. Delivers when it's resumed.\nResume once: orca orchestration send --to dispatch:dispatch-4 --resume --failure-id failure-77"
    ])
  }
)

it('preserves the observed failure identity and typed negative delivery in JSON', async () => {
  call.mockResolvedValue({ ok: true, result: receipt })
  await send([], true)
  expect(process.exitCode).toBe(1)
  expect(JSON.parse(lines[0]!).result).toMatchObject({
    delivered: false,
    state: 'held',
    reason: { kind: 'worker_failed', failure: 'network' },
    failureId: 'failure-77',
    target: { sessionId: 'worker-1', dispatchId: 'dispatch-4' }
  })
})

it('refuses missing observed recovery identity before calling the host', async () => {
  await expect(send([['resume', true]])).rejects.toMatchObject({ code: 'invalid_argument' })
  expect(call).not.toHaveBeenCalled()
})
