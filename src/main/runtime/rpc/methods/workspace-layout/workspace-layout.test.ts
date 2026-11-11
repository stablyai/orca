import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { WorkspaceLayoutStreamEvent } from '../../../../../shared/workspace-layout/workspace-layout-stream-frames'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../core'
import { ALL_RPC_METHODS } from '../rpc-method-registry'

const paired = vi.hoisted(() => ({ ids: ['one', 'two'] }))
vi.mock(
  '../../../../../shared/remote-runtime/host-store/runtime-environment-store',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    listEnvironments: () => paired.ids.map((id) => ({ id }))
  })
)

const methods = eraseRpcMethods(ALL_RPC_METHODS)
const subscribe = methods.find((method) => method.name === 'layout.subscribe')
const unsubscribeMethod = methods.find((method) => method.name === 'layout.unsubscribe')

function harness(epoch?: string) {
  const cleanups = new Map<string, () => void>()
  let publish: (event: WorkspaceLayoutStreamEvent) => void = () => {}
  const unsubscribe = vi.fn()
  const fake = {
    subscribeWorkspaceLayouts: (listener: (event: WorkspaceLayoutStreamEvent) => void) => {
      publish = listener
      return {
        snapshot: [
          {
            key: 'a',
            layout: { worktreeId: 'a', tabs: [], groups: [], editorFiles: [], browserTabs: [] }
          },
          {
            key: 'b',
            layout: { worktreeId: 'b', tabs: [], groups: [], editorFiles: [], browserTabs: [] }
          }
        ],
        seq: 4,
        ...(epoch ? { epoch } : {}),
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
    publish: (event: WorkspaceLayoutStreamEvent) => publish(event)
  }
}

describe('layout.subscribe', () => {
  it('sends each records frame with only the named workspaces, an empty one too', async () => {
    const { runtime, cleanups, publish } = harness('epoch-1')
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
    const removed = (key: string) => ({ key, change: 'removed' as const })
    publish({ type: 'records', epoch: 'epoch-1', seq: 5, workspaces: [removed('a'), removed('b')] })
    // Sent though it names none of them, so the subscriber's positions stay gapless.
    publish({ type: 'records', epoch: 'epoch-1', seq: 6, workspaces: [removed('a')] })
    runtime.cleanupSubscription([...cleanups.keys()][0]!)
    await done
    expect(emitted).toEqual([
      expect.objectContaining({ type: 'snapshot', seq: 4, epoch: 'epoch-1' }),
      { type: 'records', epoch: 'epoch-1', seq: 5, workspaces: [removed('b')] },
      { type: 'records', epoch: 'epoch-1', seq: 6, workspaces: [] },
      { type: 'end' }
    ])
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
