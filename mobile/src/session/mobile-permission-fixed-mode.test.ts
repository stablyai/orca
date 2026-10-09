import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeAll, expect, it, vi } from 'vitest'
import type { PermissionDefaultFixture } from '../../../src/shared/agent-session-permission-default.test-fixture'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import { SetOptionParams } from '../../../src/shared/rpc-contract/structured-agent-session-params'
import {
  permissionHost,
  usePermissionComposition,
  type PermissionProbeProps
} from './mobile-permission-composition.test-fixture'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))
vi.mock('./mobile-native-chat-session-option-persistence', () => ({
  persistMobileStructuredOptionPicks: vi.fn()
}))
let fixture: PermissionDefaultFixture
beforeAll(async () => {
  fixture = await vi.importActual<PermissionDefaultFixture>(
    '../../../src/main/native-chat/agent-session-wire/structured-permission-default.test-fixture'
  )
}, 60_000)

it.each([
  ['claude', 'ask'],
  ['claude', 'bypass'],
  ['codex', 'ask'],
  ['codex', 'bypass']
] as const)(
  'retains mobile %s saved %s through reads, publications and reconnect',
  async (agent, initial) => {
    const host = await fixture.permissionDefaultHost(agent, initial)
    const other = initial === 'ask' ? 'bypass' : 'ask'
    const wire = permissionHost()
    const send = wire.client.sendRequest
    wire.client.sendRequest = async (method, params, options) => {
      if (method === 'agentSession.setOption') {
        const picked = SetOptionParams.parse(params)
        return { id: 'r', ok: true, result: await host.pick(picked.value, picked.envelope) }
      }
      return send(method, params, options)
    }
    let current: ReturnType<typeof usePermissionComposition> | undefined
    let renderer: ReactTestRenderer | undefined
    function Probe(props: PermissionProbeProps): null {
      current = usePermissionComposition(props)
      return null
    }
    const read = () => {
      if (!current) {
        throw new Error('No composition')
      }
      return current
    }
    const props: PermissionProbeProps = {
      agent,
      client: wire.client,
      sessionId: host.sessionId,
      permissionSeed: host.fact()
    }
    const publish = async (event: AgentSessionSubscribeEvent | undefined) => {
      if (!event) {
        throw new Error('No frame')
      }
      await act(async () => wire.publish(event))
    }
    const show = () => read().nativeChatSessionOptions?.permissionPicker?.current
    const disconnect = async () => {
      await act(async () => renderer?.update(createElement(Probe, { ...props, connected: false })))
      await act(async () => renderer?.update(createElement(Probe, props)))
    }
    try {
      await act(async () => {
        renderer = create(createElement(Probe, props))
      })
      await act(async () => wire.attach())
      await publish(host.frames[0])
      const before = await host.storedIntent()
      const oldOptions = await host.readOptions()
      expect(show()).toBe(initial)
      expect(wire.replies.length).toBeGreaterThan(0)
      host.changeDefault(other)
      await host.publish()
      expect(host.frames).toHaveLength(1)
      await host.publish()
      expect(host.frames).toHaveLength(1)
      expect(host.fact()).toEqual({ mode: initial, fence: 7, revision: 0 })
      await publish(host.frames.at(-1))
      expect(show()).toBe(initial)
      await act(async () =>
        wire.replies.splice(0).forEach((reply) => reply({ id: 'r', ok: true, result: oldOptions }))
      )
      expect(show()).toBe(initial)
      await publish(host.frames[0])
      expect(show()).toBe(initial)
      const oldOptionsAfterDefault = await host.readOptions()
      host.changeDefault(initial)
      await disconnect()
      expect(wire.replies.length).toBeGreaterThan(0)
      const latestOptions = await host.readOptions()
      await act(async () =>
        wire.replies
          .splice(0)
          .forEach((reply) => reply({ id: 'r', ok: true, result: latestOptions }))
      )
      expect(show()).toBe(initial)
      expect(await host.storedIntent()).toEqual(before)
      expect(host.fact()).toEqual({ mode: initial, fence: 7, revision: 0 })
      await host.restart()
      await disconnect()
      await publish(await host.snapshot())
      expect(show()).toBe(initial)
      const lateReplies = wire.replies.splice(0)
      expect(lateReplies.length).toBeGreaterThan(0)
      host.permitWrites()
      await act(async () =>
        expect(await read().structured.permissionPicker?.setMode(other)).toBe(true)
      )
      expect(host.fact()).toEqual({ mode: other, fence: 7, revision: 1 })
      expect(show()).toBe(other)
      await act(async () =>
        lateReplies.forEach((reply) => reply({ id: 'r', ok: true, result: latestOptions }))
      )
      expect(show()).toBe(other)
      host.changeDefault(initial)
      await publish(host.frames[0])
      await disconnect()
      await act(async () =>
        wire.replies
          .splice(0)
          .forEach((reply) => reply({ id: 'r', ok: true, result: oldOptionsAfterDefault }))
      )
      expect(show()).toBe(other)
      await host.restart()
      await disconnect()
      await publish(await host.snapshot())
      expect(show()).toBe(other)
      expect((await host.readOptions()).permissionModes).toMatchObject({
        current: other,
        revision: 1
      })
    } finally {
      await act(async () => renderer?.unmount())
      await host.close()
    }
  }
)
