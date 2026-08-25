import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

const invoke = (name: string, flags: Map<string, string | boolean>) =>
  ORCHESTRATION_HANDLERS[name]({
    flags,
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: true
  } as never)

beforeEach(() => {
  callMock.mockReset()
  getTerminalHandleMock.mockReset()
})

describe('orchestration contract forwarding', () => {
  it('forwards an explicit self-send override to the runtime', async () => {
    callMock.mockResolvedValue({ result: { message: { id: 'msg_1' } } })
    await invoke(
      'orchestration send',
      new Map<string, string | boolean>([
        ['from', 'term_coord'],
        ['to', 'term_coord'],
        ['subject', 'intentional loop'],
        ['allow-self', true]
      ])
    )
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.send',
      expect.objectContaining({ allowSelf: true })
    )
  })

  it('forwards exact checkpoint evidence and worker identity', async () => {
    callMock.mockResolvedValue({
      result: { checkpoint: { id: 'checkpoint_1', checkpoint_hash: 'abc', status: 'checkpointed' } }
    })
    await invoke(
      'orchestration parent-checkpoint',
      new Map([
        ['dispatch', 'ctx_old'],
        ['old-parent', 'term_old'],
        ['checkpoint-state', '{"head":"abc"}'],
        ['from', 'term_worker']
      ])
    )
    expect(callMock).toHaveBeenCalledWith('orchestration.parentCheckpoint', {
      dispatch: 'ctx_old',
      oldParent: 'term_old',
      checkpoint: '{"head":"abc"}',
      from: 'term_worker'
    })
  })

  it('forwards mandatory approval evidence and lease duration', async () => {
    callMock.mockResolvedValue({
      result: {
        oldParent: 'term_old',
        newParent: 'term_new',
        oldDispatchId: 'ctx_old',
        newDispatchId: 'ctx_new',
        coordinatorEpoch: 2,
        rebindReceiptId: 'rebind_1',
        correlationId: 'corr_1'
      }
    })
    await invoke(
      'orchestration parent-rebind',
      new Map([
        ['checkpoint', 'checkpoint_1'],
        ['new-parent', 'term_new'],
        ['new-parent-pane-key', 'tab-new:cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
        ['approved-by', 'human:maintainer'],
        ['approval-id', 'approval-1'],
        ['lease-ms', '60000']
      ])
    )
    expect(callMock).toHaveBeenCalledWith('orchestration.parentRebind', {
      checkpoint: 'checkpoint_1',
      newParent: 'term_new',
      newParentPaneKey: 'tab-new:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      approvedBy: 'human:maintainer',
      approvalId: 'approval-1',
      leaseMs: 60_000
    })
  })

  it('forwards every cross-plane query-back field', async () => {
    callMock.mockResolvedValue({
      result: { state: 'completion_verified', verified: true, effectsApplied: false, missing: [] }
    })
    await invoke(
      'orchestration ack-verify',
      new Map([
        ['message-id', 'msg_1'],
        ['ack-message-id', 'msg_ack_1'],
        ['completion-receipt-id', 'msg_completion_1'],
        ['correlation-id', 'corr_1'],
        ['sender-epoch', 'orca:7'],
        ['receiver-epoch', 'herdr:12'],
        ['dispatch-id', 'ctx_1'],
        ['orca-identity', 'dispatch:ctx_1'],
        ['external-plane', 'herdr'],
        ['external-identity', 'pane:42'],
        ['link-evidence-id', 'link_1']
      ])
    )
    expect(callMock).toHaveBeenCalledWith('orchestration.crossPlaneVerify', {
      messageId: 'msg_1',
      ackMessageId: 'msg_ack_1',
      completionReceiptId: 'msg_completion_1',
      correlationId: 'corr_1',
      senderEpoch: 'orca:7',
      receiverEpoch: 'herdr:12',
      dispatchId: 'ctx_1',
      orcaIdentity: 'dispatch:ctx_1',
      externalPlane: 'herdr',
      externalIdentity: 'pane:42',
      linkEvidenceId: 'link_1'
    })
  })
})
