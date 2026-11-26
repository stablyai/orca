import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ORCHESTRATION_INBOX_HANDLERS } from './message-inbox-handlers'
import { orchestrationTestContext } from '../orchestration-handler-test-context'

const rule = {
  runId: 'run_one',
  taskId: 'task_sdk',
  question: 'Which suite should I run first?',
  options: ['unit', 'integration'],
  answer: 'unit'
}
const ask = {
  question: rule.question,
  options: rule.options,
  taskId: 'task_sdk',
  dispatchId: 'dsp_one'
}
const mail = {
  id: 'msg_question',
  thread_id: 'msg_question',
  type: 'question',
  from_handle: 'dispatch:dsp_one',
  to_handle: 'run:run_one',
  run_id: 'run_one',
  delivery_contract: 'current_delivery',
  body: rule.question,
  payload: JSON.stringify(ask)
}
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-question-preference-'))
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ version: 1, preferences: [rule] }))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function attempt(message: typeof mail) {
  const rpc = vi.fn(async (method: string) => {
    if (method === 'orchestration.inbox') {
      return { result: { messages: [message] } }
    }
    return { result: { message: { id: 'msg_answer' } } }
  })
  const flags = new Map<string, string | boolean>([
    ['run', 'run_one'],
    ['id', 'msg_question'],
    ['from', 'term_coord'],
    ['preference-file', 'owner.json']
  ])
  const response = ORCHESTRATION_INBOX_HANDLERS['orchestration reply'](
    orchestrationTestContext(rpc, flags, true, dir)
  )
  return { rpc, response }
}

it('answers a matching worker using the ordinary reply mutation', async () => {
  const { response, rpc } = attempt(mail)
  await response
  expect(rpc).toHaveBeenCalledWith(
    'orchestration.reply',
    expect.objectContaining({ run: 'run_one', id: 'msg_question', body: 'unit' })
  )
})

it.each([
  { type: 'decision_gate' },
  { run_id: 'run_other' },
  { delivery_contract: 'audit_only' },
  { from_handle: 'dispatch:dsp_other' },
  { payload: JSON.stringify({ ...ask, taskId: 'task_other' }) },
  { payload: JSON.stringify({ ...ask, options: ['unit', 'release'] }) }
])('leaves a question outside the delegated scope untouched (%j)', async (difference) => {
  const { response, rpc } = attempt({ ...mail, ...difference })
  await expect(response).rejects.toThrow()
  expect(rpc.mock.calls.map(([method]) => method)).not.toContain('orchestration.reply')
})
