import { afterEach, expect, it, vi } from 'vitest'

const callMock = vi.fn()
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

afterEach(() => callMock.mockReset())

it('accepts an explicitly attested legacy worker-server settlement', async () => {
  callMock.mockResolvedValueOnce({
    result: {
      relay: {
        messageId: 'relay_legacy_done',
        sequence: 1,
        dispatchId: 'ctx_legacy',
        destination: 'run_home',
        accepted: true
      },
      lifecycle: {
        action: 'completed',
        authority: 'worker_server_legacy'
      }
    }
  })

  await ORCHESTRATION_HANDLERS['orchestration send']({
    flags: new Map([
      ['from', 'term_worker'],
      ['subject', 'done'],
      ['type', 'worker_done'],
      ['task-id', 'task_legacy'],
      ['dispatch-id', 'ctx_legacy'],
      ['outcome', 'succeeded']
    ]),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: true
  } as never)

  expect(callMock).toHaveBeenCalledOnce()
})

it('rejects an unattested relay settlement', async () => {
  callMock.mockResolvedValueOnce({
    result: {
      relay: {
        messageId: 'relay_unattested',
        sequence: 1,
        dispatchId: 'ctx_legacy',
        destination: 'run_home',
        accepted: true
      },
      lifecycle: { action: 'completed' }
    }
  })

  await expect(
    ORCHESTRATION_HANDLERS['orchestration send']({
      flags: new Map([
        ['from', 'term_worker'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['task-id', 'task_legacy'],
        ['dispatch-id', 'ctx_legacy'],
        ['outcome', 'succeeded']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
  ).rejects.toMatchObject({ code: 'operation_unknown' })
  expect(callMock).toHaveBeenCalledOnce()
})
