import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

type RuntimeClientModule = typeof RuntimeClientExports

vi.mock('../runtime/client', async (importOriginal) => ({
  ...(await importOriginal<RuntimeClientModule>()),
  RuntimeClient: class {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }
}))

import { main } from '../index'
import type * as RuntimeClientExports from '../runtime/client'
import { okFixture, queueFixtures } from '../runtime/fixtures/runtime-rpc-fixtures'

const STEPS = [
  { command: 'click', elementIndex: 12 },
  { command: 'set-value', elementIndex: 4, value: 'hunter2' },
  { command: 'press-key', key: 'Return' }
]

describe('orca computer batch', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends every step in one call and exits 1 when the batch stops early', async () => {
    queueFixtures(
      callMock,
      okFixture('req_1', {
        steps: [
          {
            step: 1,
            command: 'click',
            ok: true,
            elapsedMs: 1500,
            verification: { state: 'unverified', reason: 'suspected_noop' }
          }
        ],
        batch: {
          total: 3,
          completed: 1,
          stopOn: 'suspect',
          stoppedAt: 1,
          stopReason: 'suspect',
          elapsedMs: 1600
        }
      })
    )

    await main(
      [
        'computer',
        'batch',
        '--session',
        'manual',
        '--app',
        'TextEdit',
        '--window-id',
        '7',
        '--steps',
        JSON.stringify(STEPS)
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith(
      'computer.batch',
      {
        session: 'manual',
        app: 'TextEdit',
        windowId: 7,
        treeDiff: true,
        noScreenshot: true,
        steps: STEPS
      },
      { timeoutMs: 240_000 }
    )
    const output = String(vi.mocked(console.log).mock.calls[0][0])
    expect(output).toContain('Batch stopped at step 1/3')
    expect(output).toContain('1. click #12: ok, unverified (suspected noop)')
    expect(output).not.toContain('hunter2')
    expect(process.exitCode).toBe(1)
  })
})
