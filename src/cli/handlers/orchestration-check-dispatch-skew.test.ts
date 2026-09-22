import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.hoisted(() => vi.fn())
const printResultMock = vi.hoisted(() => vi.fn())
vi.mock('../format', () => ({ printResult: printResultMock }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

const DISPATCH = 'ctx_7a93068d3f63'
const originalPaneKey = process.env.ORCA_PANE_KEY

/** What a host that predates `--dispatch` answers: the unknown key is stripped, the bound Run served. */
function oldHostReceipt() {
  return {
    result: {
      runId: 'run_bound',
      deliveryId: 'delivery_run_1',
      messages: [{ id: 'msg_1', subject: 'coordinate the child run' }],
      count: 1,
      replayed: false
    }
  }
}

describe('orchestration check --dispatch across version skew', () => {
  beforeEach(() => {
    callMock.mockReset()
    printResultMock.mockReset()
    delete process.env.ORCA_PANE_KEY
  })

  afterEach(() => {
    if (originalPaneKey === undefined) {
      delete process.env.ORCA_PANE_KEY
    } else {
      process.env.ORCA_PANE_KEY = originalPaneKey
    }
  })

  const invokeCheck = (flags: Map<string, string | boolean>) => {
    const context = {
      flags,
      client: { call: callMock },
      cwd: '/repo/worktree',
      json: true
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler context type carries runtime collaborators this test never reaches; `orchestration check` reads only the four fields built above, and any new read fails here rather than silently passing.
    return ORCHESTRATION_HANDLERS['orchestration check'](context as never)
  }

  const dispatchFlags = () =>
    new Map<string, string | boolean>([
      ['terminal', 'term_worker'],
      ['dispatch', DISPATCH]
    ])

  it('refuses the Run mailbox a host that ignored --dispatch served instead', async () => {
    callMock.mockResolvedValue(oldHostReceipt())

    await expect(invokeCheck(dispatchFlags())).rejects.toMatchObject({
      code: 'dispatch_selector_unsupported'
    })
    // The refusal names the mailbox that was served, and nothing is printed as if it were the one asked for.
    await expect(invokeCheck(dispatchFlags())).rejects.toThrow(/Run run_bound/)
    expect(printResultMock).not.toHaveBeenCalled()
  })

  it('accepts a receipt that carries the Dispatch the caller named', async () => {
    callMock.mockResolvedValue({
      result: {
        dispatchId: DISPATCH,
        deliveryId: 'delivery_dispatch_1',
        messages: [],
        count: 0,
        replayed: false
      }
    })

    await invokeCheck(dispatchFlags())

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({ dispatch: DISPATCH })
    )
    expect(printResultMock).toHaveBeenCalledTimes(1)
  })

  it('leaves a check without --dispatch alone when the receipt names no Dispatch', async () => {
    callMock.mockResolvedValue(oldHostReceipt())

    await invokeCheck(new Map<string, string | boolean>([['terminal', 'term_worker']]))

    expect(printResultMock).toHaveBeenCalledTimes(1)
  })
})
