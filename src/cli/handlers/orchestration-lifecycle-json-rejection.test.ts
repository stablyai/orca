import { afterEach, expect, it, vi } from 'vitest'
import { reportCliError } from '../format'
import { ORCHESTRATION_HANDLERS } from './orchestration'

afterEach(() => {
  vi.restoreAllMocks()
})

it('prints a rejected lifecycle verdict as a JSON failure envelope', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const client = {
    call: vi.fn().mockResolvedValue({
      result: {
        message: { id: 'msg_rejected' },
        lifecycle: {
          action: 'rejected',
          code: 'sender_not_assignee',
          reason: 'dispatch ctx_1 expected the assigned pane'
        }
      }
    })
  }
  let rejection: unknown
  try {
    await ORCHESTRATION_HANDLERS['orchestration send']({
      flags: new Map([
        ['from', 'term_foreign'],
        ['to', 'term_coord'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['outcome', 'succeeded']
      ]),
      client,
      cwd: '/tmp/repo',
      json: true
    } as never)
  } catch (error) {
    rejection = error
  }

  expect(rejection).toBeDefined()
  reportCliError(rejection, true, { commandPath: ['orchestration', 'send'] })

  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
    ok: false,
    error: {
      code: 'sender_not_assignee',
      message: 'dispatch ctx_1 expected the assigned pane'
    }
  })
})
