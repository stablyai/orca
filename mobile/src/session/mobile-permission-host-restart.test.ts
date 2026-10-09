import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeAll, expect, it, vi } from 'vitest'
import type { PermissionRestartFixture } from '../../../src/shared/agent-session-permission-restart.test-fixture'
import { SetOptionParams } from '../../../src/shared/rpc-contract/structured-agent-session-params'
import {
  permissionHost,
  permissionSnapshot,
  usePermissionComposition,
  type PermissionProbeProps
} from './mobile-permission-composition.test-fixture'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))
vi.mock('./mobile-native-chat-session-option-persistence', () => ({
  persistMobileStructuredOptionPicks: vi.fn()
}))

let fixture: PermissionRestartFixture
beforeAll(async () => {
  fixture = await vi.importActual<PermissionRestartFixture>(
    '../../../src/main/native-chat/agent-session-wire/structured-permission-restart.test-fixture'
  )
}, 60_000)

it.each(['claude', 'codex'] as const)(
  'keeps successful %s permission picks after reopening the real store with the client mounted',
  async (agent) => {
    for (const retained of ['ask', 'bypass'] as const) {
      const host = await fixture.permissionRestartHost(agent, retained)
      const wire = permissionHost()
      const original = wire.client.sendRequest
      wire.client.sendRequest = async (method, params, options) => {
        if (method === 'agentSession.setOption') {
          const picked = SetOptionParams.parse(params)
          return { id: 'r', ok: true, result: await host.pick(picked.value, picked.envelope) }
        }
        return original(method, params, options)
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
      const prior = host.fact()
      const props: PermissionProbeProps = {
        agent,
        client: wire.client,
        sessionId: host.sessionId,
        permissionSeed: prior
      }
      const publish = (fact: typeof prior) => {
        const snapshot = permissionSnapshot(fact.mode, fact.fence, host.sessionId)
        if (snapshot.type === 'end') {
          throw new Error('Expected snapshot')
        }
        wire.publish({ ...snapshot, permissionRevision: fact.revision })
      }
      try {
        await act(async () => {
          renderer = create(createElement(Probe, props))
        })
        await act(async () => wire.attach())
        await act(async () => publish(prior))
        expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe(retained)
        await host.restart()
        expect(host.fact()).toEqual(prior)
        await act(async () =>
          renderer?.update(createElement(Probe, { ...props, permissionSeed: host.fact() }))
        )
        const requested = retained === 'ask' ? 'bypass' : 'ask'
        await act(async () => {
          expect(await read().structured.permissionPicker?.setMode(requested)).toBe(true)
        })
        const accepted = host.fact()
        expect(accepted).toEqual({ mode: requested, fence: 7, revision: prior.revision + 1 })
        expect(read().structured.permissionPicker).toMatchObject({
          current: requested,
          pending: false
        })
        await act(async () => publish(accepted))
        const options = await host.readOptions()
        await act(async () =>
          wire.replies.forEach((reply) => reply({ id: 'r', ok: true, result: options }))
        )
        expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe(requested)
        await act(async () => publish(prior))
        expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe(requested)
      } finally {
        await act(async () => renderer?.unmount())
        await host.close()
      }
    }
  }
)
