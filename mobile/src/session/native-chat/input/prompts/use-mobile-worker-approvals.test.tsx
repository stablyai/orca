import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { HostStatusGatesContext } from '../../../../components/host-connection/host-protocol-gates-context'
import type { HostStatusGates } from '../../../../transport/connection/host-status-gates'
import { stubRpcClient } from '../../../../transport/rpc/rpc-client-test-stub'
import { buildRequestStreamUnsubscribe } from '../../../../transport/rpc/rpc-client-terminal-subscription'
import { useMobileWorkerApprovals, type MobileWorkerApprovals } from './use-mobile-worker-approvals'

const SESSION = 'orca_session_id:7f6b0c1e-0d64-4a3e-9b7e-2f4f0a0e6c11'

const open = {
  approval: {
    v: 1,
    approvalId: 'apr_bash',
    state: 'open',
    worker: { handle: 'term_worker', dispatchId: 'ctx_1', taskId: 'task_1' },
    summary: { title: 'Allow Bash?', detail: 'ls', reason: null },
    allowedActions: ['allow', 'deny']
  },
  at: '2026-11-19T21:00:00.000Z',
  worker: {
    partyKey: 'w',
    role: 'worker',
    label: 'builder',
    agentKind: 'claude',
    status: 'blocked',
    openTarget: { kind: 'terminal', handle: 'term_worker' }
  }
}

function gatesWith(capabilities: string[]): HostStatusGates {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only hostCapabilities.
  return { hostCapabilities: capabilities } as HostStatusGates
}

function mount(capabilities: string[]) {
  const gates = gatesWith(capabilities)
  let emit: (frame: unknown) => void = () => {}
  const subscribe = vi.fn((_method: string, _params: unknown, onData: (r: unknown) => void) => {
    emit = onData
    return () => {}
  })
  const sendRequest = vi.fn(async () => ({
    id: '1',
    ok: true as const,
    result: { approvalId: 'apr_bash' },
    _meta: { runtimeId: 'host' }
  }))
  const client = stubRpcClient({ subscribe, sendRequest })
  const view: { current: MobileWorkerApprovals | null } = { current: null }
  function Probe(): null {
    view.current = useMobileWorkerApprovals({
      client,
      connState: 'connected',
      sessionId: SESSION.slice('orca_session_id:'.length),
      onAnswerError: () => {}
    })
    return null
  }
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(
      <HostStatusGatesContext.Provider value={gates}>
        <Probe />
      </HostStatusGatesContext.Provider>
    )
  })
  return {
    view,
    subscribe,
    sendRequest,
    emit: (frame: unknown) => act(() => emit(frame)),
    renderer
  }
}

describe('phone worker approvals', () => {
  it('asks only a host that answers paired phones', () => {
    const { subscribe } = mount([])
    expect(subscribe).not.toHaveBeenCalled()
  })

  it("lists a coordinator's open worker prompt and answers it on the host as an orchestration write", async () => {
    const { view, subscribe, sendRequest, emit } = mount([
      'orchestration.paired-worker-approvals.v1'
    ])
    expect(subscribe).toHaveBeenCalledWith(
      'orchestration.workerApprovalsSubscribe',
      { party: SESSION },
      expect.any(Function)
    )
    emit({ type: 'begin' })
    emit({ type: 'approval', entry: open })
    emit({ type: 'complete' })
    expect(view.current?.open.map((entry) => entry.approval.approvalId)).toEqual(['apr_bash'])

    await act(async () => {
      expect(await view.current!.answer(view.current!.open[0]!, 'deny')).toBe(true)
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'orchestration.approvalAnswer',
      { dispatch: 'ctx_1', prompt: 'apr_bash', decision: 'deny', reason: 'Denied by the owner.' },
      expect.objectContaining({ envelope: { orchestrationContractVersion: 1 } })
    )
  })

  it('ends its host stream by the request that opened it when the chat closes', () => {
    expect(
      buildRequestStreamUnsubscribe(
        'orchestration.workerApprovalsSubscribe',
        { party: SESSION },
        'req-7'
      )
    ).toEqual({
      method: 'orchestration.workerApprovalsUnsubscribe',
      params: { subscriptionId: 'req-7' }
    })
  })
})
