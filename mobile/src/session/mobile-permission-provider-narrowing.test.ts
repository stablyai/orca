import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeAll, expect, it, vi } from 'vitest'
import type { PermissionNarrowingFixture } from '../../../src/shared/agent-session-permission-narrowing.test-fixture'
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

let fixture: PermissionNarrowingFixture
beforeAll(async () => {
  fixture = await vi.importActual<PermissionNarrowingFixture>(
    '../../../src/main/native-chat/agent-session-wire/structured-permission-narrowing.test-fixture'
  )
}, 60_000)

it.each(['codex-start', 'claude-start', 'claude-model'] as const)(
  'shows durable Ask on mobile after %s narrows Auto through the production host',
  async (scenario) => {
    const host = await fixture.permissionNarrowingHost(scenario)
    const wire = permissionHost()
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
      agent: host.agent,
      client: wire.client,
      sessionId: host.sessionId,
      permissionSeed: host.fact()
    }
    try {
      await act(async () => {
        renderer = create(createElement(Probe, props))
      })
      await act(async () => wire.attach())
      await act(async () => host.frames.forEach((event) => wire.publish(event)))
      expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe('auto')
      const before = host.frames.length
      await host.start()
      if (scenario === 'claude-model') {
        expect(host.fact()).toMatchObject({ mode: 'auto', revision: 9 })
        await host.switchModel()
      }
      const narrowed = host.fact()
      expect(narrowed).toEqual({ mode: 'ask', fence: 8, revision: 10 })
      expect(await host.storedIntent()).toMatchObject({
        options: { permissionMode: 'ask' },
        permissionRevision: 10
      })
      await act(async () => host.frames.slice(before).forEach((event) => wire.publish(event)))
      expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe('ask')
      const options = await host.readOptions()
      expect(options.permissionModes).toMatchObject({ current: 'ask', fence: 8, revision: 10 })
      await act(async () =>
        wire.replies.forEach((reply) => reply({ id: 'r', ok: true, result: options }))
      )
      expect(read().structured.permissionPicker).toMatchObject({ current: 'ask', pending: false })
      const latest = host.frames.at(-1)
      if (!latest || latest.type === 'end') {
        throw new Error('No provider publication')
      }
      await act(async () =>
        wire.publish({ ...latest, permissionMode: 'auto', permissionRevision: 9 })
      )
      expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe('ask')
    } finally {
      await act(async () => renderer?.unmount())
      await host.close()
    }
  }
)
