import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionPermissionSeed } from '../../../src/shared/agent-chat-permission-mode'
import type { MobileSessionTab } from './mobile-session-route-types'
import {
  MODEL_PLACEHOLDER_ONLY,
  permissionHost,
  usePermissionComposition
} from './mobile-permission-composition.test-fixture'
import { permissionTabScope } from './mobile-permission-tab-application.test-fixture'
import { useMobileSessionTabApplication } from './use-mobile-session-tab-application'

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

async function mount(agent: 'claude' | 'codex', host: ReturnType<typeof permissionHost>) {
  let current: ReturnType<typeof usePermissionComposition> | undefined
  let apply: ReturnType<typeof useMobileSessionTabApplication>['applySessionTabs'] | undefined
  let renderedTabs: MobileSessionTab[] = []
  function Probe({ open }: { open: boolean }): null {
    const [tabs, setTabs] = useState<MobileSessionTab[]>([])
    const [scope] = useState(() => permissionTabScope(setTabs, host.client))
    renderedTabs = tabs
    apply = useMobileSessionTabApplication(scope).applySessionTabs
    const tab = tabs.find((candidate) => candidate.id === scope.activeSessionTabIdRef.current)
    current = usePermissionComposition({
      agent,
      client: host.client,
      open: open && tab?.type === 'agent-session',
      permissionSeed: tab?.type === 'agent-session' ? tab.permissionSeed : undefined
    })
    return null
  }
  await act(async () => {
    renderer = create(createElement(Probe, { open: true }))
  })
  let version = 0
  const publish = async (permissionSeed?: AgentSessionPermissionSeed) => {
    const tab: MobileSessionTab = {
      type: 'agent-session',
      id: 'tab',
      title: 'Chat',
      sessionId: 'chat',
      agent,
      isActive: true,
      ...(permissionSeed ? { permissionSeed } : {})
    }
    await act(async () => {
      if (!apply) {
        throw new Error('No tab application')
      }
      apply({
        worktree: 'folder:workspace',
        publicationEpoch: 'host',
        snapshotVersion: ++version,
        tabs: [tab],
        activeTabId: 'tab',
        activeTabType: 'agent-session'
      })
    })
  }
  const read = () => {
    if (!current) {
      throw new Error('No composition')
    }
    return current
  }
  return {
    read,
    publish,
    tabs: () => renderedTabs,
    open: async (open: boolean) => {
      await act(async () => renderer?.update(createElement(Probe, { open })))
    }
  }
}

const updates: { name: string; seed?: AgentSessionPermissionSeed }[] = [
  { name: 'mode change', seed: { mode: 'bypass', fence: 7 } },
  { name: 'fence change', seed: { mode: 'ask', fence: 8 } },
  { name: 'seed removal' }
]

it.each(['claude', 'codex'] as const)(
  'applies %s seed-only tab changes before reopening under pending and failed reads',
  async (agent) => {
    for (const update of updates) {
      const host = permissionHost()
      const { read, publish, open, tabs } = await mount(agent, host)
      await publish({ mode: 'ask', fence: 7 })
      expect(read().nativeChatSessionOptions?.permissionPicker?.current).toBe('ask')
      const originalTabs = tabs()
      await publish({ mode: 'ask', fence: 7 })
      expect(tabs()).toBe(originalTabs)
      await open(false)
      await publish(update.seed)
      expect(tabs(), update.name).not.toBe(originalTabs)
      await open(true)
      const picker = read().nativeChatSessionOptions?.permissionPicker
      expect(picker?.current ?? null, `${update.name} pending`).toBe(update.seed?.mode ?? null)
      expect(read().structured.optionSnapshot).toEqual(MODEL_PLACEHOLDER_ONLY)
      await act(async () => host.failReads())
      expect(
        read().nativeChatSessionOptions?.permissionPicker?.current ?? null,
        `${update.name} failed`
      ).toBe(update.seed?.mode ?? null)
      if (update.seed) {
        await act(async () => {
          expect(await read().structured.permissionPicker?.setMode('auto')).toBe(true)
        })
        expect(host.handleRequest).toHaveBeenCalledWith(
          'agentSession.setOption',
          expect.objectContaining({
            envelope: expect.objectContaining({ expectedRuntimeFence: update.seed.fence })
          }),
          expect.anything()
        )
      }
      await act(async () => renderer?.unmount())
      renderer = undefined
    }
  }
)
