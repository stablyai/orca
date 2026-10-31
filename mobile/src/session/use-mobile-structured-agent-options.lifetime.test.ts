import * as selectionOperations from '../../../src/shared/structured-agent-session-selection-operations'
import { createElement, StrictMode, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { OptionsParams } from '../../../src/shared/rpc-contract/structured-agent-session-params'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type { StructuredAgentSessionMutate } from './mobile-structured-agent-session-rpc'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import { requestStructuredAgentSessionMutation } from './mobile-structured-agent-session-rpc'
import { useMobileStructuredSelectionController } from './use-mobile-structured-selection-controller'
import {
  settle,
  accepted,
  OPTIONS,
  BASE,
  deferred,
  rpcSuccess,
  optionsClient,
  queuedReads,
  recordingMutate,
  mountOptions,
  currentValueOf
} from './use-mobile-structured-agent-options.test-fixture'

function acceptedWrite({ fields }: { fields: Record<string, unknown> }) {
  const { key, value } = fields
  if (typeof key !== 'string' || typeof value !== 'string') {
    throw new Error('expected a recorded option write')
  }
  return accepted({ key, value, options: { [key]: value } }, true)
}

it('keeps actual phone operations and correlated acceptance through a stable-client path migration', async () => {
  const stale = deferred<AgentSessionOptionsResult>()
  let oldReads = 0
  const physical = optionsClient(() =>
    ++oldReads === 1 ? Promise.resolve({ ...OPTIONS, acceptsImages: true }) : stale.promise
  )
  const currentReads: ReturnType<typeof deferred<AgentSessionOptionsResult>>[] = []
  const next = optionsClient(() => {
    const read = deferred<AgentSessionOptionsResult>()
    currentReads.push(read)
    return read.promise
  })
  const reply = deferred<ReturnType<typeof rpcSuccess>>()
  const send = physical.client.sendRequest
  physical.client.sendRequest = (method, params, options) =>
    method === 'agentSession.setOption' ? reply.promise : send(method, params, options)
  const client = createStableLogicalRpcClient(physical.client, 'lan')
  const mutate: StructuredAgentSessionMutate = async <TValue>(
    method: string,
    fingerprintMethod: string,
    fields: Record<string, unknown>
  ) => {
    const result = await requestStructuredAgentSessionMutation<TValue>({
      client,
      method,
      fingerprintMethod,
      fields,
      sessionId: BASE.sessionId,
      expectedRuntimeFence: 1
    })
    return result.status === 'accepted'
      ? { status: 'accepted', value: result.value, sameFence: false }
      : result.status === 'unknown'
        ? { status: 'unknown' }
        : { status: 'rejected' }
  }
  const view = await mountOptions({ ...BASE, client, mutate, sendSelection: true })
  let pick!: Promise<boolean>
  act(() => {
    pick = view.current().setStructuredOption('model', 'gpt-fast')
  })
  await view.rerender({ optionStamp: 'old-query' })
  await act(async () => {
    await client.migrateTo(next.client, 'relay')
  })
  await settle()
  await act(async () =>
    stale.resolve({ ...OPTIONS, acceptsImages: false, conversationCommands: ['compact'] })
  )
  expect(view.current().conversationCommands).toEqual([])
  expect(view.current().acceptsImages).toBe(true)
  expect(currentValueOf(view.current().optionSnapshot, 'model')).toBe('gpt-fast')
  expect(view.current().sendSelection()).toMatchObject({ selection: { model: 'gpt-fast' } })
  await act(async () =>
    reply.resolve(rpcSuccess({ ok: true, value: { options: { model: 'gpt-fast' } } }))
  )
  await expect(pick).resolves.toBe(true)
  expect(next.methods('settings.mutateNativeChatSessionOptions')).toHaveLength(1)
  // The first current query began before acceptance; its trailing query captures the terminal ID.
  await act(async () => currentReads[0].resolve(OPTIONS))
  await settle()
  await act(async () => currentReads.at(-1)!.resolve(OPTIONS))
  await settle()
  expect(currentValueOf(view.current().optionSnapshot, 'model')).toBe('gpt-live')
  await view.unmount()
  client.close()
})

it.each(['session', 'client'] as const)(
  'ends actual %s scope and cleanup replay without reviving setup-time work',
  async (boundary) => {
    const firstClient = optionsClient(queuedReads(OPTIONS))
    const replacement = optionsClient(queuedReads(OPTIONS))
    let current!: selectionOperations.StructuredSessionSelectionController
    const setups: {
      controller: selectionOperations.StructuredSessionSelectionController
      operation: selectionOperations.SelectionOperation
    }[] = []
    let cleanups = 0
    function Scope({ sessionId, client }: { sessionId: string; client: RpcClient }) {
      const { controller } = useMobileStructuredSelectionController({
        agent: 'codex',
        client,
        sessionId,
        onRevalidate: () => {}
      })
      current = controller
      useEffect(() => {
        setups.push({ controller, operation: controller.issue('model', 'gpt-live', null) })
        return () => {
          cleanups++
        }
      }, [controller])
      return null
    }
    const element = (sessionId: string, client: RpcClient) =>
      createElement(StrictMode, null, createElement(Scope, { sessionId, client }))
    let root!: ReactTestRenderer
    await act(async () => {
      root = create(element('scope-A', firstClient.client))
    })
    expect(setups).toHaveLength(2)
    expect(cleanups).toBe(1)
    const old = setups[0]
    await expect(old.operation.result).resolves.toEqual({ kind: 'superseded' })
    act(() =>
      old.controller.settle(old.operation, { kind: 'accepted', options: { model: 'gpt-live' } })
    )
    expect(firstClient.methods('settings.mutateNativeChatSessionOptions')).toHaveLength(0)
    const live = setups[1]
    act(() =>
      live.controller.settle(live.operation, { kind: 'accepted', options: { model: 'gpt-live' } })
    )
    await settle()
    expect(firstClient.methods('settings.mutateNativeChatSessionOptions')).toHaveLength(1)
    const first = current
    const held = first.issue('model', 'gpt-fast', null)
    await act(async () =>
      root.update(
        element(
          boundary === 'session' ? 'scope-B' : 'scope-A',
          boundary === 'client' ? replacement.client : firstClient.client
        )
      )
    )
    await expect(held.result).resolves.toEqual({ kind: 'superseded' })
    act(() => first.settle(held, { kind: 'accepted', options: { model: 'gpt-fast' } }))
    await expect(first.issue('model', 'dead', null).result).resolves.toEqual({ kind: 'superseded' })
    expect(current).not.toBe(first)
    const latest = setups.at(-1)!
    act(() =>
      latest.controller.settle(latest.operation, {
        kind: 'accepted',
        options: { model: 'gpt-live' }
      })
    )
    await settle()
    expect(firstClient.methods('settings.mutateNativeChatSessionOptions')).toHaveLength(
      boundary === 'session' ? 2 : 1
    )
    expect(replacement.methods('settings.mutateNativeChatSessionOptions')).toHaveLength(
      boundary === 'client' ? 1 : 0
    )
    const last = current
    const unmounted = last.issue('model', 'gpt-fast', null)
    await act(async () => root.unmount())
    await expect(unmounted.result).resolves.toEqual({ kind: 'superseded' })
    await expect(last.issue('model', 'dead', null).result).resolves.toEqual({ kind: 'superseded' })
  }
)

it('reads the new physical path after an idle connected-to-connected migration without an operation wake', async () => {
  const old = optionsClient(queuedReads(OPTIONS))
  const answers: ReturnType<typeof deferred<AgentSessionOptionsResult>>[] = []
  let cause = 'connected-callback'
  const causes: string[] = []
  const next = optionsClient(() => {
    causes.push(cause)
    const answer = deferred<AgentSessionOptionsResult>()
    answers.push(answer)
    return answer.promise
  })
  const client = createStableLogicalRpcClient(old.client, 'lan')
  const { mutate } = recordingMutate(async () => ({ status: 'rejected' }))
  const view = await mountOptions({ ...BASE, client, mutate })
  expect(old.optionReads()).toBe(1)
  expect(view.current().conversationCommands).toEqual([])
  await act(async () => {
    await client.migrateTo(next.client, 'relay')
    cause = 'generation-read-effect'
  })
  await settle()
  expect(next.optionReads()).toBeGreaterThanOrEqual(1)
  expect(next.optionReads()).toBeLessThanOrEqual(2)
  // The contact callback can start one read before React installs the generation-keyed reader.
  expect(causes.filter((entry) => entry === 'connected-callback').length).toBeLessThanOrEqual(1)
  expect(causes.filter((entry) => entry === 'generation-read-effect')).toHaveLength(1)
  await act(async () => {
    for (const answer of answers) {
      answer.resolve({ ...OPTIONS, conversationCommands: ['compact'] })
    }
  })
  await settle()
  expect(view.current().conversationCommands).toEqual(['compact'])
  expect(next.methods('agentSession.setOption')).toHaveLength(0)
  await view.unmount()
  client.close()
})

it('coalesces a burst of turns into one running and one trailing options read', async () => {
  const reads: ReturnType<typeof deferred<AgentSessionOptionsResult>>[] = []
  const rpc = optionsClient(() => {
    const read = deferred<AgentSessionOptionsResult>()
    reads.push(read)
    return read.promise
  })
  const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
  const view = await mountOptions({ ...BASE, client: rpc.client, mutate })
  expect(reads).toHaveLength(1)
  await act(async () => reads[0].resolve(OPTIONS))
  await settle()
  for (let turn = 1; turn <= 10; turn++) {
    await view.rerender({ turnId: `turn-${turn}` })
  }
  expect(reads).toHaveLength(2)
  await act(async () => reads[1].resolve({ ...OPTIONS, conversationCommands: ['clear'] }))
  await settle()
  expect(view.current().conversationCommands).toEqual([])
  expect(reads).toHaveLength(3)
  await act(async () => reads[2].resolve({ ...OPTIONS, conversationCommands: ['compact'] }))
  await settle()
  expect(reads).toHaveLength(3)
  expect(view.current().conversationCommands).toEqual(['compact'])
  await view.unmount()
})

it.each(['current', 'failed-then-wake', 'true-end'] as const)(
  'settles a late refusal after a physical reset without losing progress (%s)',
  async (schedule) => {
    const old = optionsClient(queuedReads(OPTIONS))
    const reads: ReturnType<typeof Promise.withResolvers<AgentSessionOptionsResult>>[] = []
    let cause = 'connected-callback'
    const causes: string[] = []
    const next = optionsClient(() => {
      causes.push(cause)
      const read = Promise.withResolvers<AgentSessionOptionsResult>()
      reads.push(read)
      return read.promise
    })
    const client = createStableLogicalRpcClient(old.client, 'lan')
    const reply = deferred<{ status: 'rejected' }>()
    const { calls, mutate } = recordingMutate(() => reply.promise)
    const view = await mountOptions({ ...BASE, client, mutate, sendSelection: true })
    let picking!: Promise<boolean>
    act(() => {
      picking = view.current().setStructuredOption('model', 'gpt-fast')
    })
    await act(async () => {
      await client.migrateTo(next.client, 'relay')
      cause = 'generation-read-effect'
    })
    const current: AgentSessionOptionsResult = {
      ...OPTIONS,
      current: { model: 'gpt-live', effort: 'high' },
      conversationCommands: ['compact']
    }
    await act(async () => {
      for (const read of reads) {
        if (schedule === 'failed-then-wake') {
          read.reject(new Error('offline'))
        } else {
          read.resolve(current)
        }
      }
    })
    if (schedule === 'true-end') {
      cause = 'replacement-session-read'
      await view.rerender({ sessionId: 'replacement' })
    }
    const readsBeforeReply = next.optionReads()
    cause = 'late-result-revalidation'
    await act(async () => reply.resolve({ status: 'rejected' }))
    await expect(picking).resolves.toBe(schedule === 'true-end')
    expect(view.current().pendingOptionId).toBeNull()
    expect(calls).toHaveLength(1)
    expect(next.optionReads()).toBeLessThanOrEqual(schedule === 'current' ? 2 : 3)
    const requested = next.methods('agentSession.options').map(({ params }, index) => ({
      ...OptionsParams.parse(params),
      cause: causes[index]
    }))
    expect(requested).toHaveLength(causes.length)
    // Migration and replacement install different session readers; each trigger issues once.
    for (const reason of [
      'connected-callback',
      'generation-read-effect',
      'replacement-session-read',
      'late-result-revalidation'
    ]) {
      expect(causes.filter((entry) => entry === reason).length).toBeLessThanOrEqual(1)
    }
    expect(causes).toContain('generation-read-effect')
    for (const request of requested) {
      expect(request.sessionId).toBe(
        request.cause === 'replacement-session-read' ? 'replacement' : BASE.sessionId
      )
    }
    if (schedule === 'true-end') {
      expect(requested.filter((request) => request.cause === 'replacement-session-read')).toEqual([
        { sessionId: 'replacement', cause: 'replacement-session-read' }
      ])
      expect(next.optionReads()).toBe(readsBeforeReply)
      expect(causes).not.toContain('late-result-revalidation')
    }
    expect(next.methods('settings.mutateNativeChatSessionOptions')).toHaveLength(0)
    if (schedule === 'failed-then-wake') {
      expect(currentValueOf(view.current().optionSnapshot, 'model')).toBe('gpt-live')
      const beforeWake = reads.length
      cause = 'status-wake'
      await view.rerender({ optionStamp: 'legitimate-status-wake' })
      expect(reads.length).toBe(beforeWake + 1)
      await act(async () => reads.at(-1)!.resolve(current))
    }
    if (schedule !== 'true-end') {
      expect(currentValueOf(view.current().optionSnapshot, 'model')).toBe('gpt-live')
      expect(view.current().conversationCommands).toEqual(['compact'])
      expect(view.current().sendSelection()).toMatchObject({
        selection: { model: 'gpt-live', effort: 'high' }
      })
    } else {
      expect(view.current().sendSelection()).toEqual({ selection: {} })
    }
    await view.unmount()
    client.close()
  }
)

it.each([false, true])(
  'never promotes permission or older model busy state after settlement (permission first=%s)',
  async (permissionFirst) => {
    const idle = deferred<AgentSessionOptionsResult>()
    let reads = 0
    const rpc = optionsClient(() =>
      ++reads === 1
        ? Promise.resolve({ ...OPTIONS, current: { ...OPTIONS.current, permissionMode: 'ask' } })
        : idle.promise
    )
    const replies = [
      deferred<ReturnType<typeof accepted>>(),
      deferred<ReturnType<typeof accepted>>()
    ]
    const { calls, mutate } = recordingMutate((index) => replies[index].promise)
    const view = await mountOptions({ ...BASE, client: rpc.client, mutate, sendSelection: true })
    act(() => {
      void view.current().setStructuredOption('model', 'gpt-fast')
    })
    await act(async () =>
      expect(await view.current().setStructuredOption('model', 'gpt-live')).toBe(false)
    )
    act(() => {
      void view.current().setStructuredOption('permissionMode', 'full-access')
    })
    expect(view.current().pendingOptionId).toBeNull()
    for (const index of permissionFirst ? [1, 0] : [0, 1]) {
      await act(async () => replies[index].resolve(acceptedWrite(calls[index])))
      expect(view.current().pendingOptionId).toBeNull()
      expect(currentValueOf(view.current().optionSnapshot, 'model')).toBe('gpt-fast')
      expect(currentValueOf(view.current().optionSnapshot, 'permissionMode')).toBe('full-access')
      expect(view.current().sendSelection()).toMatchObject({ selection: { model: 'gpt-fast' } })
    }
    expect(calls.map((call) => call.fields)).toEqual([
      { key: 'model', value: 'gpt-fast' },
      { key: 'permissionMode', value: 'full-access' }
    ])
    await view.unmount()
  }
)

it('bounds real phone permission projection work with 10 and 100 retained operations', async () => {
  const measurements: number[] = []
  for (const count of [10, 100]) {
    const factory = vi.spyOn(selectionOperations, 'createStructuredSessionSelectionController')
    const blocked = deferred<AgentSessionOptionsResult>()
    let reads = 0
    const rpc = optionsClient(() =>
      ++reads === 1
        ? Promise.resolve({ ...OPTIONS, current: { ...OPTIONS.current, permissionMode: 'ask' } })
        : blocked.promise
    )
    const replies = Array.from({ length: count }, () => deferred<ReturnType<typeof accepted>>())
    const { calls, mutate } = recordingMutate((index) => replies[index].promise)
    const view = await mountOptions({ ...BASE, client: rpc.client, mutate })
    const result = factory.mock.results.at(-1)!
    if (result.type !== 'return') {
      throw new Error('real hook did not construct its owner')
    }
    const controller = result.value
    const issue = vi.spyOn(controller, 'issue')
    let visits = 0
    for (let index = 0; index < count; index++) {
      const before = visits
      act(() => {
        void view.current().setStructuredOption('permissionMode', index % 2 ? 'ask' : 'full-access')
      })
      expect(visits - before).toBeLessThanOrEqual(40)
      const issued = issue.mock.results.at(-1)!
      if (issued.type !== 'return') {
        throw new Error('permission not admitted')
      }
      const operation = issued.value
      for (const key of ['identity', 'key', 'transmitted', 'outcome'] as const) {
        let value = operation[key]
        Object.defineProperty(operation, key, {
          configurable: true,
          get() {
            visits++
            return value
          },
          set(next) {
            value = next
          }
        })
      }
    }
    const issueVisits = visits
    expect(issueVisits).toBeLessThanOrEqual(40 * count)
    visits = 0
    for (let index = count - 1; index >= 0; index--) {
      const before = visits
      await act(async () => replies[index].resolve(acceptedWrite(calls[index])))
      expect(view.current().pendingOptionId).toBeNull()
      expect(visits - before).toBeLessThanOrEqual(40)
    }
    expect(calls).toHaveLength(count)
    expect(visits).toBeLessThanOrEqual(40 * count)
    measurements.push(issueVisits + visits)
    await view.unmount()
    issue.mockRestore()
    factory.mockRestore()
  }
  expect(measurements[1]).toBeLessThanOrEqual(measurements[0] * 11)
})
