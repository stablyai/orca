import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionPermissionSeed } from '../../../src/shared/agent-chat-permission-mode'
import {
  permissionHost,
  permissionSnapshot,
  usePermissionComposition,
  type PermissionProbeProps
} from './mobile-permission-composition.test-fixture'
import type { MobileSessionTab } from './mobile-session-route-types'
import { permissionTabScope } from './mobile-permission-tab-application.test-fixture'
import { useMobileSessionTabApplication } from './use-mobile-session-tab-application'
import { mobileSessionTabsEqual } from './mobile-terminal-records'

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

it.each(['claude', 'codex'] as const)(
  'reopens %s with the newer seed and sends its fence despite cached transcript authority',
  async (agent) => {
    for (const seed of [
      { mode: 'bypass', fence: 7, revision: 3 },
      { mode: 'ask', fence: 8, revision: 0 }
    ] satisfies AgentSessionPermissionSeed[]) {
      const host = permissionHost()
      let current: ReturnType<typeof usePermissionComposition> | undefined
      let apply: ReturnType<typeof useMobileSessionTabApplication>['applySessionTabs'] | undefined
      function Probe(props: PermissionProbeProps): null {
        const [tabs, setTabs] = useState<MobileSessionTab[]>([])
        const [scope] = useState(() => permissionTabScope(setTabs, host.client))
        apply = useMobileSessionTabApplication(scope).applySessionTabs
        const tab = tabs.find((entry) => entry.id === scope.activeSessionTabIdRef.current)
        current = usePermissionComposition({
          ...props,
          open: props.open !== false && tab?.type === 'agent-session',
          permissionSeed: tab?.type === 'agent-session' ? tab.permissionSeed : undefined
        })
        return null
      }
      let version = 0
      const publishSeed = async (permissionSeed: AgentSessionPermissionSeed) => {
        await act(async () => {
          if (!apply) {
            throw new Error('No tab application')
          }
          apply({
            worktree: 'folder:workspace',
            publicationEpoch: 'host',
            snapshotVersion: ++version,
            tabs: [
              {
                type: 'agent-session',
                id: 'tab',
                title: 'Chat',
                sessionId: 'chat',
                agent,
                isActive: true,
                permissionSeed
              }
            ],
            activeTabId: 'tab',
            activeTabType: 'agent-session'
          })
        })
      }
      let props: PermissionProbeProps = {
        agent,
        client: host.client,
        sessionKey: `reopen:${agent}:${seed.fence}`
      }
      const read = () => {
        if (!current) {
          throw new Error('No composition')
        }
        return current
      }
      const update = async (change: Partial<PermissionProbeProps>) => {
        props = { ...props, ...change }
        await act(async () => renderer?.update(createElement(Probe, props)))
      }
      await act(async () => {
        renderer = create(createElement(Probe, props))
      })
      await publishSeed({ mode: 'auto', fence: 7, revision: 2 })
      await act(async () => host.attach())
      const snapshot = permissionSnapshot('auto')
      if (snapshot.type === 'end') {
        throw new Error('Expected snapshot')
      }
      await act(async () => host.publish({ ...snapshot, permissionRevision: 2 }))
      expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe('auto')
      await update({ open: false })
      await publishSeed(seed)
      await update({ open: true })
      expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe(seed.mode)
      await act(async () => host.failReads())
      expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe(seed.mode)
      host.handleRequest.mockImplementation(async (method) =>
        method === 'agentSession.setOption'
          ? {
              id: 'r',
              ok: true,
              result: {
                ok: true,
                value: {
                  key: 'permissionMode',
                  value: 'bypass',
                  permissionFact: { mode: 'bypass', fence: seed.fence, revision: seed.revision + 1 }
                }
              }
            }
          : new Promise(() => {})
      )
      await act(async () => {
        expect(await read().structured.permissionPicker?.setMode('bypass')).toBe(true)
      })
      expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe('bypass')
      expect(host.handleRequest).toHaveBeenCalledWith(
        'agentSession.setOption',
        expect.objectContaining({
          envelope: expect.objectContaining({ expectedRuntimeFence: seed.fence })
        }),
        expect.anything()
      )
      await act(async () => renderer?.unmount())
      renderer = undefined
    }
  }
)

it('applies a revision-only seed update at the tab comparison boundary', () => {
  const tab = {
    type: 'agent-session',
    id: 'chat',
    title: 'Chat',
    sessionId: 'chat',
    agent: 'codex',
    isActive: true
  } as const
  expect(
    mobileSessionTabsEqual(
      [{ ...tab, permissionSeed: { mode: 'ask', fence: 7, revision: 1 } }],
      [{ ...tab, permissionSeed: { mode: 'ask', fence: 7, revision: 2 } }]
    )
  ).toBe(false)
})

it.each(['claude', 'codex'] as const)(
  'admits newer %s permission facts after model-state resets',
  async (agent) => {
    const host = permissionHost()
    let current: ReturnType<typeof usePermissionComposition> | undefined
    function Probe(props: PermissionProbeProps): null {
      current = usePermissionComposition(props)
      return null
    }
    const props: PermissionProbeProps = {
      agent,
      client: host.client,
      permissionSeed: { mode: 'ask', fence: 7, revision: 0 }
    }
    await act(async () => {
      renderer = create(createElement(Probe, props))
    })
    const originalRead = host.replies[0]
    if (!originalRead) {
      throw new Error('No original options read')
    }
    await act(async () => renderer?.update(createElement(Probe, { ...props, open: false })))
    await act(async () => renderer?.update(createElement(Probe, props)))
    await act(async () => {
      originalRead({
        id: 'r',
        ok: true,
        result: {
          models: [],
          current: {},
          permissionModes: {
            current: 'bypass',
            supported: ['ask', 'auto', 'bypass'],
            fence: 7,
            revision: 3
          }
        }
      })
    })
    expect(current?.nativeChatSessionOptions?.permissionPicker?.current).toBe('bypass')
  }
)
