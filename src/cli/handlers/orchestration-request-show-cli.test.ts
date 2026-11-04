import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { orchestrationTestContext } from './orchestration-handler-test-context'

async function runRequestShow(): Promise<void> {
  await ORCHESTRATION_HANDLERS['orchestration request-show'](
    orchestrationTestContext(
      callMock,
      new Map<string, string | boolean>([
        ['full', true],
        ['request', 'request_1']
      ]),
      false
    )
  )
}

describe('orchestration request-show', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
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
