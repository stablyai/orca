import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { WorkspaceLayoutEvent } from '../../../../shared/workspace-layout/workspace-layout-stream-frames'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../core'
import { ALL_RPC_METHODS } from './index'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'

const methods = eraseRpcMethods(ALL_RPC_METHODS)
const subscribe = methods.find((method) => method.name === 'layout.subscribe')
const unsubscribeMethod = methods.find((method) => method.name === 'layout.unsubscribe')
const getRemoteSnapshots = methods.find((method) => method.name === 'layout.getRemoteSnapshots')

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
        seq: 4,
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
    const [cleanupKey] = [...cleanups.keys()]
    expect(emitted).toEqual([
      {
        type: 'snapshot',
        subscriptionId: expect.any(String),
        workspaces: [{ key: 'b', layout: { worktreeId: 'b' } }],
        seq: 4
      }
    ])
    publish({ type: 'removed', key: 'a', seq: 5 })
    publish({ type: 'removed', key: 'b', seq: 6 })
    runtime.cleanupSubscription(cleanupKey!)
    await done
    expect(emitted.slice(1)).toEqual([{ type: 'removed', key: 'b', seq: 6 }, { type: 'end' }])
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('ends a subscription only for the connection that opened it', async () => {
    const { runtime, unsubscribe } = harness()
    const emitted: unknown[] = []
    if (!subscribe || !isStreamingMethod(subscribe) || !unsubscribeMethod) {
      throw new Error('layout methods are missing')
    }
    if (isStreamingMethod(unsubscribeMethod)) {
      throw new Error('layout.unsubscribe is not a request method')
    }
    const done = subscribe.handler(
      undefined,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime and connectionId from its context.
      { runtime, connectionId: 'conn-1' } as RpcContext,
      (event) => emitted.push(event)
    )
    const [snapshot] = emitted
    const subscriptionId =
      snapshot && typeof snapshot === 'object' && 'subscriptionId' in snapshot
        ? snapshot.subscriptionId
        : undefined
    expect(subscriptionId).toEqual(expect.any(String))

    await unsubscribeMethod.handler(
      { subscriptionId },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime and connectionId from its context.
      { runtime, connectionId: 'conn-2' } as RpcContext
    )
    expect(unsubscribe).not.toHaveBeenCalled()

    await unsubscribeMethod.handler(
      { subscriptionId },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime and connectionId from its context.
      { runtime, connectionId: 'conn-1' } as RpcContext
    )
    await done
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(emitted.at(-1)).toEqual({ type: 'end' })
  })
})

describe('layout.getRemoteSnapshots', () => {
  it('is served but neither advertised nor open to phones (inert)', () => {
    expect(getRemoteSnapshots?.permission).toBe('workspace')
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('layout.getRemoteSnapshots')).toBe(false)
  })

  it('returns the stored snapshot of each known server', async () => {
    const snapshots = {
      one: { workspaces: { a: { worktree: 'a', tabs: [] } } },
      two: { workspaces: {} }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler calls only getRemoteLayoutSnapshots.
    const runtime = { getRemoteLayoutSnapshots: () => snapshots } as unknown as OrcaRuntimeService
    if (!getRemoteSnapshots || isStreamingMethod(getRemoteSnapshots)) {
      throw new Error('layout.getRemoteSnapshots is not a request method')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime from its context.
    const result = await getRemoteSnapshots.handler(undefined, { runtime } as RpcContext)
    expect(result).toEqual({ snapshots })
  })
})
