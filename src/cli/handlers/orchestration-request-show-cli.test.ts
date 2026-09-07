// `request-show` is the recovery path a lost mutation response sends you down, so it must
// stay read-only, render the honest reading, and name a version gap instead of a raw RPC error.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

async function runRequestShow(): Promise<void> {
  await ORCHESTRATION_HANDLERS['orchestration request-show']({
    flags: new Map<string, string | boolean>([['request', 'request_1']]),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: false
  } as never)
}

describe('orchestration request-show', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
  })

  it('asks the runtime without sending a mutation request id', async () => {
    callMock.mockResolvedValue({ requestId: 'request_1', state: 'absent', interpretation: 'none' })

    await runRequestShow()

    expect(callMock).toHaveBeenCalledWith('orchestration.requestShow', { request: 'request_1' })
  })

  it('renders the state and the honest reading of it', async () => {
    const result = {
      requestId: 'request_1',
      state: 'completed',
      method: 'orchestration.workerStart',
      interpretation: 'Request request_1 already took effect.'
    }
    callMock.mockResolvedValue(result)

    await runRequestShow()

    const [value, , render] = vi.mocked(printResult).mock.calls[0] as [
      unknown,
      boolean,
      (value: unknown) => string
    ]
    expect(render(value)).toBe(
      'request_1 [completed] orchestration.workerStart\nRequest request_1 already took effect.'
    )
  })

  it('names the version gap when the server predates the command', async () => {
    callMock.mockRejectedValue(
      new RuntimeClientError('method_not_found', 'Unknown method: orchestration.requestShow')
    )

    await expect(runRequestShow()).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message: expect.stringContaining('Update Orca on the server')
    })
  })
})
