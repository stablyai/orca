import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeAll, expect, it, vi } from 'vitest'
import type { PermissionAcquisitionFixture } from '../../../src/shared/agent-session-permission-acquisition.test-fixture'
import {
  permissionHost,
  usePermissionComposition
} from './mobile-permission-composition.test-fixture'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))
vi.mock('./mobile-native-chat-session-option-persistence', () => ({
  persistMobileStructuredOptionPicks: vi.fn()
}))
let fixture: PermissionAcquisitionFixture
beforeAll(async () => {
  fixture = await vi.importActual<PermissionAcquisitionFixture>(
    '../../../src/main/native-chat/agent-session-wire/structured-permission-acquisition.test-fixture'
  )
}, 60_000)

it.each([
  ['claude', 'ask'],
  ['claude', 'bypass'],
  ['codex', 'ask'],
  ['codex', 'bypass']
] as const)(
  'keeps mobile %s labels on acquired %s after the default changes',
  async (agent, initial) => {
    const host = await fixture.permissionAcquisitionHost(agent, initial)
    const seed = host.fact()
    const before = await host.readOptions()
    await host.start()
    // Claude withholds its initialize answer, so the default changes under a still-starting child.
    expect(host.childPhase()).toBe(agent === 'claude' ? 'starting' : 'ready')
    expect(await host.storedIntent()).toMatchObject({
      options: { permissionMode: initial },
      permissionRevision: 0
    })
    host.updateSettings({ nativeChatPermissionMode: initial === 'ask' ? 'bypass' : 'ask' })
    const wire = permissionHost()
    let current: ReturnType<typeof usePermissionComposition> | undefined
    let renderer: ReactTestRenderer | undefined
    function Probe(): null {
      current = usePermissionComposition({
        agent,
        client: wire.client,
        sessionId: host.sessionId,
        permissionSeed: seed
      })
      return null
    }
    const show = () => current?.nativeChatSessionOptions?.permissionPicker?.current
    try {
      await act(async () => {
        renderer = create(createElement(Probe))
      })
      await act(async () => wire.attach())
      await act(async () => wire.publish(await host.snapshot()))
      expect(host.fact()).toEqual({ mode: initial, fence: 8, revision: 0 })
      expect(show()).toBe(initial)
      await act(async () =>
        wire.replies.splice(0).forEach((reply) => reply({ id: 'r', ok: true, result: before }))
      )
      expect(show()).toBe(initial)
      host.answerInitialize()
      await host.send()
      await vi.waitFor(() => expect(host.delivered()).toBe(1))
      expect(host.launchMode()).toBe(initial)
      expect(host.controls()).toEqual([])
      expect((await host.readOptions()).permissionModes).toMatchObject({
        current: initial,
        revision: 0
      })
      expect(show()).toBe(host.launchMode())
    } finally {
      await act(async () => renderer?.unmount())
      await host.close()
    }
  }
)
