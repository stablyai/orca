import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { RuntimeClient } from '../runtime-client'
import type { OrchestrationCheckOutput } from '../../shared/orchestration-check-output'

const callMock = vi.hoisted(() => vi.fn())
const printResultMock = vi.hoisted(() => vi.fn())
vi.mock('../format', () => ({ printResult: printResultMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

describe('CLI replay recovery across host versions', () => {
  beforeEach(() => {
    callMock.mockReset()
    printResultMock.mockReset()
    vi.stubEnv('ORCA_CLI_COMMAND', 'orca-ide')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  function invoke(flags: [string, string | boolean][], json: boolean) {
    const client = new RuntimeClient('/folder-workspace/.test-orca', 60_000, null, null, 'orca-ide')
    vi.spyOn(client, 'call').mockImplementation(callMock)
    const context: HandlerContext = {
      flags: new Map([['terminal', 'term_original'], ...flags]),
      client,
      cwd: '/folder-workspace',
      json
    }
    return ORCHESTRATION_HANDLERS['orchestration check'](context)
  }
  function printed(): OrchestrationCheckOutput {
    const response: unknown = printResultMock.mock.calls[0]?.[0]
    if (
      typeof response === 'object' &&
      response &&
      'result' in response &&
      typeof response.result === 'object' &&
      response.result &&
      'messages' in response.result &&
      'count' in response.result
    ) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked response is an orchestration check result and was prepared by the real handler.
      return response.result as OrchestrationCheckOutput
    }
    throw new Error('Expected printed check receipt')
  }
  function oldHostResult() {
    return {
      runId: 'run_receipt_owner',
      messages: [{ id: 'msg_old', from_handle: 'worker' }],
      count: 1,
      deliveryId: 'delivery_old',
      replayed: true
    }
  }

  it.each([false, true])(
    'projects old-host recovery into actual JSON and text: json=%s',
    async (json) => {
      callMock.mockResolvedValue({ result: oldHostResult() })
      await invoke([], json)
      const result = printed()
      expect(result.replayRecovery).toMatchObject({
        ackCommand: 'orca-ide orchestration check --terminal term_original --ack delivery_old',
        guidance:
          'Process every message in this batch before acknowledging, then process the next batch returned.'
      })
      expect(result.replayRecovery).not.toHaveProperty('waitingCount')
      expect(JSON.parse(JSON.stringify(result))).toHaveProperty('replayRecovery.ackCommand')
      const formatter = printResultMock.mock.calls[0]?.[2]
      expect(formatter?.(result)).toContain('Delivery delivery_old (replayed)')
      expect(formatter?.(result)).not.toContain('0 unread messages')
      expect(formatter?.(result)).not.toContain('--run run_receipt_owner')
      expect(callMock).toHaveBeenCalledTimes(1)
    }
  )

  it('preserves explicit Run selection while omitting unavailable backlog counts', async () => {
    callMock.mockResolvedValue({ result: oldHostResult() })
    await invoke(
      [
        ['run', 'run_selected'],
        ['format', true]
      ],
      true
    )
    expect(printed().replayRecovery?.ackCommand).toBe(
      'orca-ide orchestration check --terminal term_original --run run_selected --ack delivery_old'
    )
  })

  it('keeps new-host recovery count and guidance in JSON and formatted output', async () => {
    callMock.mockResolvedValue({
      result: {
        ...oldHostResult(),
        formatted: 'Message body',
        replayRecovery: {
          waitingCount: 83,
          ackCommand: 'orca-dev orchestration check --terminal term_original --ack delivery_old',
          guidance:
            'Process every message in this batch before acknowledging, then process the next batch returned.'
        }
      }
    })
    await invoke([['format', true]], true)
    expect(printed().replayRecovery?.waitingCount).toBe(83)
    expect(printResultMock.mock.calls[0]?.[2]?.(printed())).toContain(
      '83 unread messages waiting behind this Delivery.'
    )
  })

  it.each([
    ['peek', true],
    ['all', true]
  ] as const)('omits fallback for inspection %s', async (flag, value) => {
    callMock.mockResolvedValue({ result: oldHostResult() })
    await invoke([[flag, value]], true)
    expect(printed()).not.toHaveProperty('replayRecovery')
  })

  it('omits fallback for legacy recovery reads', async () => {
    callMock.mockResolvedValue({
      result: { ...oldHostResult(), legacyCompatibility: { readOnly: true, recovery: true } }
    })
    await invoke([], true)
    expect(printed()).not.toHaveProperty('replayRecovery')
  })
})
