// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostStatusGates } from '../transport/host-status-gates'
import type { HostPendingViewChanges } from './use-host-pending-view-changes'
import { RUNTIME_CAPABILITIES } from '../../../src/shared/protocol-version'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import { FakeSession, FakeLogicalClient } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'

const foreground = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }))
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      foreground.listeners.add(listener)
      return { remove: () => foreground.listeners.delete(listener) }
    }
  }
}))
vi.mock('../transport/host-app-version-store', () => ({ recordHostAppVersion: async () => {} }))
vi.mock('../transport/host-descriptor-recorder', () => ({
  recordHostDescriptorFromStatus: () => {}
}))
import { useHostStatusGates } from '../transport/host-status-gates'
import { useHostPendingViewChanges } from './use-host-pending-view-changes'

let root: Root | undefined
let container: HTMLElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  expect(foreground.listeners.size).toBe(0)
})
const reply = (result: unknown): RpcResponse => ({
  id: 'reply',
  ok: true,
  result,
  _meta: { runtimeId: 'desktop' }
})

it.each([100, 1000])(
  'joins status recovery and %i wake/overwrite signals through actual pending dispatch and settlement',
  async (count) => {
    const client = new FakeLogicalClient('connected', 'lan')
    let malformed = true
    const sends: unknown[] = []
    let answer!: (reply: RpcResponse) => void
    client.sendRequest.mockImplementation(async (method, params) => {
      if (method === 'status.get') {
        return reply(malformed ? null : { capabilities: [...RUNTIME_CAPABILITIES] })
      }
      sends.push(params)
      return new Promise<RpcResponse>((resolve) => {
        answer = resolve
      })
    })
    let gates!: HostStatusGates
    let writer!: HostPendingViewChanges
    function Probe() {
      gates = useHostStatusGates({ client, hostId: 'desktop', connState: client.getState() })
      writer = useHostPendingViewChanges(
        client,
        gates.projectRepoFilterSupport,
        gates.statusGeneration
      )
      return null
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(createElement(Probe)))
    expect(gates.projectRepoFilterSupport).toBe('unknown')
    await act(async () => {
      await writer.controls.sendView(
        { sortBy: 'name', filters: { filterRepoIds: ['old'] } },
        { sortBy: 'name', filterRepoIds: ['old'] },
        'exact'
      )
      for (let index = 0; index < count; index++) {
        await writer.controls.sendView(
          { filters: { filterRepoIds: [`new-${index}`] } },
          { filterRepoIds: [`new-${index}`] },
          'exact'
        )
      }
    })
    // Superseding only the filter releases surviving Sort; no stale filter or mode is sent with it.
    expect(sends).toEqual([{ sortBy: 'name' }])
    const sortAnswer = answer
    await act(async () => sortAnswer(reply({ ui: { sortBy: 'name' } })))
    expect(writer.status.pending).toHaveLength(1)
    malformed = false
    await act(async () => {
      for (let index = 0; index < count; index++) {
        foreground.listeners.forEach((listener) => listener('active'))
      }
    })
    expect(gates.projectRepoFilterSupport).toBe('exact')
    expect(sends).toEqual([
      { sortBy: 'name' },
      { filterRepoIds: [`new-${count - 1}`], filterRepoIdsMode: 'exact' }
    ])
    await act(async () => answer(reply({ ui: { filterRepoIds: [`new-${count - 1}`] } })))
    expect(writer.status.pending).toEqual([])
    // A burst during one active probe has at most one follow-up, and never installs filter capability lists.
    expect(
      client.sendRequest.mock.calls.filter(([method]) => method === 'status.get').length
    ).toBeLessThanOrEqual(3)
    expect(
      client.sendRequest.mock.calls.filter(
        ([method]) => method === 'runtime.clientCapabilities.update'
      )
    ).toHaveLength(0)
    const retainedControls = writer.controls
    let late!: Promise<unknown>
    await act(async () => {
      late = retainedControls.sendView(
        { filters: { filterRepoIds: ['late'] } },
        { filterRepoIds: ['late'] },
        'exact'
      )
    })
    const beforeRelease = client.sendRequest.mock.calls.length
    await act(async () => root!.unmount())
    root = undefined
    await act(async () => answer(reply({ ui: { filterRepoIds: ['late'] } })))
    await expect(late).resolves.toBe('waiting')
    await expect(
      retainedControls.sendView({ sortBy: 'recent' }, { sortBy: 'recent' })
    ).resolves.toBe('waiting')
    foreground.listeners.forEach((listener) => listener('active'))
    expect(client.sendRequest.mock.calls).toHaveLength(beforeRelease)
  }
)

it('fences A→B→A dispatch and late settlements through the real logical generation owner', async () => {
  const a1 = new FakeSession('connected')
  const a2 = new FakeSession('connected')
  const b1 = new FakeSession('connected')
  const completions = new Map<string, (value: RpcResponse) => void>()
  const writes: { owner: string; params: unknown }[] = []
  let releaseA2Status: ((response: RpcResponse) => void) | undefined
  for (const [owner, session] of [
    ['a1', a1],
    ['a2', a2],
    ['b1', b1]
  ] as const) {
    session.sendRequest.mockImplementation(async (method, params) => {
      if (method === 'status.get') {
        if (owner === 'a2') {
          return new Promise<RpcResponse>((resolve) => {
            releaseA2Status = resolve
          })
        }
        return reply({ capabilities: [...RUNTIME_CAPABILITIES] })
      }
      writes.push({ owner, params })
      return new Promise<RpcResponse>((resolve) => {
        completions.set(owner, resolve)
      })
    })
  }
  const a = createStableLogicalRpcClient(a1, 'lan')
  const b = createStableLogicalRpcClient(b1, 'relay')
  let writer!: HostPendingViewChanges
  let gates!: HostStatusGates
  let layoutStep: 'b-unknown' | 'b-exact' | 'a-unknown' | 'a-exact' | undefined
  const observed: string[] = []
  let retainedA: HostPendingViewChanges['controls'] | undefined
  let retiredControl: Promise<unknown> | undefined
  let bWrite: Promise<unknown> | undefined
  let aWrite: Promise<unknown> | undefined
  let waitingA: Promise<unknown> | undefined
  function Probe({ client, owner }: { client: RpcClient; owner: string }) {
    gates = useHostStatusGates({ client, hostId: owner, connState: client.getState() })
    writer = useHostPendingViewChanges(
      client,
      gates.projectRepoFilterSupport,
      gates.statusGeneration
    )
    useLayoutEffect(() => {
      const stage = layoutStep
      if (stage === 'b-unknown' && owner === 'B') {
        layoutStep = 'b-exact'
        observed.push(stage)
        expect(gates.projectRepoFilterSupport).toBe('unknown')
        retiredControl = retainedA!.sendView(
          { filters: { filterRepoIds: ['retired-A'] } },
          { filterRepoIds: ['retired-A'] },
          'exact'
        )
        expect(writes.map((write) => write.owner)).toEqual(['a1'])
        expect(writer.status.pending).toEqual([])
      } else if (
        stage === 'b-exact' &&
        owner === 'B' &&
        gates.projectRepoFilterSupport === 'exact'
      ) {
        layoutStep = undefined
        observed.push(stage)
        bWrite = writer.controls.sendView(
          { filters: { filterRepoIds: ['B-old'] } },
          { filterRepoIds: ['B-old'] },
          'exact'
        )
        expect(writes).toHaveLength(2)
        expect(writes[1]).toEqual({
          owner: 'b1',
          params: { filterRepoIds: ['B-old'], filterRepoIdsMode: 'exact' }
        })
      } else if (stage === 'a-unknown' && owner === 'A') {
        layoutStep = 'a-exact'
        observed.push(stage)
        expect(gates.projectRepoFilterSupport).toBe('unknown')
        waitingA = writer.controls.sendView(
          { filters: { filterRepoIds: ['A-pending'] } },
          { filterRepoIds: ['A-pending'] },
          'exact'
        )
        expect(writes).toHaveLength(2)
      } else if (
        stage === 'a-exact' &&
        owner === 'A' &&
        gates.projectRepoFilterSupport === 'exact'
      ) {
        layoutStep = undefined
        observed.push(stage)
        expect(gates.statusGeneration).toBe(2)
        aWrite = writer.controls.sendView(
          { filters: { filterRepoIds: ['A-new'] } },
          { filterRepoIds: ['A-new'] },
          'exact'
        )
        expect(writes).toHaveLength(3)
        expect(writes[2]).toEqual({
          owner: 'a2',
          params: { filterRepoIds: ['A-new'], filterRepoIdsMode: 'exact' }
        })
      }
    })
    return null
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const show = async (client: RpcClient, owner: string) => {
    await act(async () => root!.render(createElement(Probe, { client, owner })))
    expect(gates.projectRepoFilterSupport).toBe('exact')
    expect(gates.statusGeneration).toBe(client.getGeneration?.())
  }
  const author = async (id: string) => {
    let result!: Promise<unknown>
    await act(async () => {
      result = writer.controls.sendView(
        { filters: { filterRepoIds: [id] } },
        { filterRepoIds: [id] },
        'exact'
      )
    })
    return { result }
  }
  try {
    await show(a, 'A')
    const staleA = await author('A-old')
    retainedA = writer.controls
    layoutStep = 'b-unknown'
    await show(b, 'B')
    await expect(retiredControl).resolves.toBe('waiting')
    const staleB = { result: bWrite }
    expect(writes.map((write) => write.owner)).toEqual(['a1', 'b1'])
    await act(async () => {
      await a.migrateTo(a2, 'tailscale')
    })
    expect(a.getGeneration()).toBe(2)
    layoutStep = 'a-unknown'
    await act(async () => root!.render(createElement(Probe, { client: a, owner: 'A' })))
    expect(gates.projectRepoFilterSupport).toBe('unknown')
    await expect(waitingA).resolves.toBe('waiting')
    expect(writer.status.pending[0]).toMatchObject({ payload: { filterRepoIds: ['A-pending'] } })
    expect(releaseA2Status).toBeDefined()
    await act(async () => releaseA2Status!(reply({ capabilities: [...RUNTIME_CAPABILITIES] })))
    const successor = { result: aWrite }
    expect(observed).toEqual(['b-unknown', 'b-exact', 'a-unknown', 'a-exact'])
    expect(writes).toEqual([
      { owner: 'a1', params: { filterRepoIds: ['A-old'], filterRepoIdsMode: 'exact' } },
      { owner: 'b1', params: { filterRepoIds: ['B-old'], filterRepoIdsMode: 'exact' } },
      { owner: 'a2', params: { filterRepoIds: ['A-new'], filterRepoIdsMode: 'exact' } }
    ])
    await act(async () => {
      completions.get('a1')!(reply({ ui: { filterRepoIds: ['A-old'] } }))
      completions.get('b1')!(reply({ ui: { filterRepoIds: ['B-old'] } }))
    })
    await expect(staleA.result).resolves.toBe('waiting')
    await expect(staleB.result).resolves.toBe('waiting')
    expect(writer.status.pending).toHaveLength(1)
    expect(writer.status.pending[0]).toMatchObject({ payload: { filterRepoIds: ['A-new'] } })
    await act(async () => completions.get('a2')!(reply({ ui: { filterRepoIds: ['A-new'] } })))
    await expect(successor.result).resolves.toBe('settled')
    expect(writer.status.pending).toEqual([])
    const retained = writer.controls
    await act(async () => root!.unmount())
    root = undefined
    const count = writes.length
    await expect(retained.sendView({ sortBy: 'name' }, { sortBy: 'name' })).resolves.toBe('waiting')
    foreground.listeners.forEach((listener) => listener('active'))
    expect(writes).toHaveLength(count)
  } finally {
    a.close()
    b.close()
  }
})
