import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusFact } from '../../../../shared/agent-status-fact-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { isStreamingMethod, type RpcContext, type RpcStreamingMethod } from '../core'
import { ALL_RPC_METHODS } from './index'

const subscribeMethod = ALL_RPC_METHODS.find(
  (method) => method.name === 'agent.status.subscribe' && isStreamingMethod(method)
) as RpcStreamingMethod

const unsubscribeMethod = ALL_RPC_METHODS.find(
  (method) => method.name === 'agent.status.unsubscribe'
)!

const fact: AgentStatusFact = {
  epoch: 'epoch-1',
  seq: 4,
  paneKey: 'tab:leaf',
  worktreeId: 'wt-1',
  status: null
}

describe('agent status fact RPC', () => {
  it('emits ready, replay, live facts, and end on cleanup', async () => {
    const emitted: unknown[] = []
    let liveListener: ((next: AgentStatusFact) => void) | null = null
    let cleanup: (() => void) | null = null
    const unsubscribe = vi.fn()
    const runtime = {
      registerSubscriptionCleanup: vi.fn((_id: string, callback: () => void) => {
        cleanup = callback
      }),
      onAgentStatusFact: vi.fn((listener: (next: AgentStatusFact) => void) => {
        liveListener = listener
        return {
          replay: { epoch: 'epoch-1', headSeq: 4, gap: false, facts: [fact] },
          unsubscribe
        }
      })
    } as unknown as OrcaRuntimeService

    const pending = subscribeMethod.handler(
      { lastSeenSeq: 3, epoch: 'epoch-1' },
      { runtime, connectionId: 'conn-1', requestId: 'req-1' } as RpcContext,
      (message) => emitted.push(message)
    )

    await vi.waitFor(() => expect(emitted).toHaveLength(2))
    expect(emitted).toEqual([
      {
        type: 'ready',
        subscriptionId: 'agent-status:conn-1:req-1',
        epoch: 'epoch-1',
        headSeq: 4,
        gap: false
      },
      { type: 'fact', fact }
    ])
    liveListener!(fact)
    expect(emitted).toHaveLength(3)

    cleanup!()
    await pending
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(emitted.at(-1)).toEqual({ type: 'end' })
  })

  it('only allows the owning connection to unsubscribe', async () => {
    const cleanup = vi.fn()
    const runtime = {
      cleanupSubscription: cleanup
    } as unknown as OrcaRuntimeService
    const context = { runtime, connectionId: 'conn-1' } as RpcContext

    await unsubscribeMethod.handler(
      { subscriptionId: 'agent-status:conn-2:req-1' },
      context,
      () => {}
    )
    expect(cleanup).not.toHaveBeenCalled()

    await unsubscribeMethod.handler(
      { subscriptionId: 'agent-status:conn-1:req-1' },
      context,
      () => {}
    )
    expect(cleanup).toHaveBeenCalledWith('agent-status:conn-1:req-1')
  })
})
