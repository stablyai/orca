import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { WorkspaceLayoutEvent } from '../../workspace-layout-stream'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../core'
import { ALL_RPC_METHODS } from './index'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'

const subscribe = eraseRpcMethods(ALL_RPC_METHODS).find(
  (method) => method.name === 'layout.subscribe'
)

function harness() {
  const cleanups = new Map<string, () => void>()
  let publish: (event: WorkspaceLayoutEvent) => void = () => {}
  const unsubscribe = vi.fn()
  const fake = {
    subscribeWorkspaceLayouts: (listener: (event: WorkspaceLayoutEvent) => void) => {
      publish = listener
      return {
        snapshot: [
          { key: 'a', layout: { worktreeId: 'a' } },
          { key: 'b', layout: { worktreeId: 'b' } }
        ],
        unsubscribe
      }
    },
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
    cleanupSubscription: (id: string) => cleanups.get(id)?.()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler calls only the three runtime methods this fake implements.
  const runtime = fake as unknown as OrcaRuntimeService
  return {
    runtime,
    cleanups,
    unsubscribe,
    publish: (event: WorkspaceLayoutEvent) => publish(event)
  }
}

describe('layout.subscribe', () => {
  it('is served but neither advertised nor open to phones (inert)', () => {
    expect(subscribe && isStreamingMethod(subscribe)).toBe(true)
    expect(RUNTIME_CAPABILITIES.some((capability) => capability.startsWith('layout'))).toBe(false)
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('layout.subscribe')).toBe(false)
  })

  it('sends the snapshot, then the named workspaces’ changes, and ends on unsubscribe', async () => {
    const { runtime, cleanups, unsubscribe, publish } = harness()
    const emitted: unknown[] = []
    if (!subscribe || !isStreamingMethod(subscribe)) {
      throw new Error('layout.subscribe is not a streaming method')
    }
    const done = subscribe.handler(
      { workspaces: ['b'] },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime and connectionId from its context.
      { runtime, connectionId: 'conn-1' } as RpcContext,
      (event) => emitted.push(event)
    )
    const [subscriptionId] = [...cleanups.keys()]
    expect(emitted).toEqual([
      {
        type: 'snapshot',
        subscriptionId,
        workspaces: [{ key: 'b', layout: { worktreeId: 'b' } }]
      }
    ])
    publish({ type: 'removed', key: 'a' })
    publish({ type: 'removed', key: 'b' })
    runtime.cleanupSubscription(subscriptionId!)
    await done
    expect(emitted.slice(1)).toEqual([{ type: 'removed', key: 'b' }, { type: 'end' }])
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
