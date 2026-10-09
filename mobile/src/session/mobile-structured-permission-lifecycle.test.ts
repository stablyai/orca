import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import {
  MODEL_PLACEHOLDER_ONLY,
  permissionHost,
  permissionOptions,
  permissionSnapshot,
  permissionBatch,
  usePermissionComposition,
  type PermissionProbeProps
} from './mobile-permission-composition.test-fixture'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))
vi.mock('./mobile-native-chat-session-option-persistence', () => ({
  persistMobileStructuredOptionPicks: vi.fn()
}))

let renderer: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
})

async function mount(agent: string, host: ReturnType<typeof permissionHost>) {
  let current: ReturnType<typeof usePermissionComposition> | undefined
  function Probe(props: PermissionProbeProps): null {
    current = usePermissionComposition(props)
    return null
  }
  const props = { agent, client: host.client, permissionSeed: { mode: 'ask' as const, fence: 7 } }
  await act(async () => {
    renderer = create(createElement(Probe, props))
  })
  const read = () => {
    if (!current) {
      throw new Error('No composition')
    }
    return current
  }
  return {
    read,
    update: async (next: Partial<PermissionProbeProps>) => {
      await act(async () => renderer?.update(createElement(Probe, { ...props, ...next })))
    }
  }
}

it.each(['claude', 'codex'])(
  'keeps an accepted %s pick through first attachment and failed options refresh',
  async (agent) => {
    const host = permissionHost()
    const { read } = await mount(agent, host)
    expect(host.replies).toHaveLength(1)
    await act(async () => {
      expect(await read().structured.permissionPicker?.setMode('auto')).toBe(true)
    })
    expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe('auto')
    expect(host.handleRequest).toHaveBeenCalledWith(
      'agentSession.setOption',
      expect.objectContaining({ envelope: expect.objectContaining({ expectedRuntimeFence: 7 }) }),
      expect.anything()
    )
    await act(async () => host.attach())
    await act(async () => host.publish(permissionSnapshot('auto')))
    expect(read().structured.optionSnapshot).toEqual(MODEL_PLACEHOLDER_ONLY)
    expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe('auto')
    await act(async () => host.replies[0](permissionOptions('ask')))
    expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe('auto')
    await act(async () => host.failReads())
    expect(read().nativeChatSessionOptions?.permissionPicker).toMatchObject({
      current: 'auto',
      pending: false
    })
  }
)

it.each(['claude', 'codex'])(
  'shows newer %s host publications without any successful options read',
  async (agent) => {
    const host = permissionHost()
    const { read } = await mount(agent, host)
    await act(async () => host.attach())
    await act(async () => host.publish(permissionSnapshot('bypass')))
    expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe('bypass')
    await act(async () => host.publish(permissionBatch('ask')))
    expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe('ask')
    await act(async () => host.failReads())
    expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe('ask')
    expect(read().structured.optionSnapshot).toEqual(MODEL_PLACEHOLDER_ONLY)
  }
)

it.each(['claude', 'codex'])(
  'orders a repeated %s publication after a write and rejects its earlier read',
  async (agent) => {
    const host = permissionHost()
    const { read } = await mount(agent, host)
    await act(async () => host.attach())
    await act(async () => host.publish(permissionSnapshot('ask')))
    await act(async () => {
      await read().structured.permissionPicker?.setMode('auto')
    })
    expect(read().structured.permissionPicker?.current).toBe('auto')
    const recovery = host.replies.at(-1)
    await act(async () => host.publish(permissionBatch('ask')))
    expect(read().structured.permissionPicker?.current).toBe('ask')
    await act(async () => recovery?.(permissionOptions('auto')))
    expect(read().structured.permissionPicker?.current).toBe('ask')
    expect(read().structured.optionSnapshot).toHaveLength(1)
  }
)

it.each(['claude', 'codex'])(
  'rejects a stale %s publication and leaves ordinary transcript batches out of permission ordering',
  async (agent) => {
    const host = permissionHost()
    const { read } = await mount(agent, host)
    await act(async () => host.attach())
    await act(async () => host.publish(permissionSnapshot('ask')))
    await act(async () => host.publish(permissionBatch('bypass', 2)))
    const readCount = host.replies.length
    await act(async () => host.publish(permissionBatch('auto', 1)))
    expect(read().structured.permissionPicker?.current).toBe('bypass')
    expect(host.replies).toHaveLength(readCount)
    await act(async () => {
      await read().structured.permissionPicker?.setMode('auto')
    })
    await act(async () =>
      host.publish({
        type: 'batch',
        sessionId: 'chat',
        batch: {
          cursor: { epoch: 'epoch', sequence: 3 },
          items: [],
          removedItemIds: [],
          submissions: []
        }
      })
    )
    expect(read().structured.permissionPicker?.current).toBe('auto')
  }
)

it.each(['claude', 'codex'])(
  'isolates %s confirmations from another host using the same session id',
  async (agent) => {
    const host = permissionHost()
    const { read, update } = await mount(agent, host)
    await act(async () => {
      await read().structured.permissionPicker?.setMode('auto')
    })
    await update({ sessionKey: 'another-host:chat', permissionSeed: { mode: 'bypass', fence: 7 } })
    expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe('bypass')
    await act(async () => host.replies[0](permissionOptions('ask')))
    expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe('bypass')
  }
)
