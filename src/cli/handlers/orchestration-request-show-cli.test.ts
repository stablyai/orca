import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { okFixture } from '../test-fixtures'

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
    callMock.mockResolvedValue(
      okFixture('req_show', { requestId: 'request_1', state: 'absent', interpretation: 'none' })
    )

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
    const response = okFixture('req_show', result)
    callMock.mockResolvedValue(response)

    await runRequestShow()

    expect(printResult).toHaveBeenCalledWith(response, false, expect.any(Function))
    const printCall = vi.mocked(printResult).mock.calls[0]
    if (!printCall) {
      throw new Error('request-show did not print its response')
    }
    expect(printCall[2](printCall[0].result)).toBe(
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
