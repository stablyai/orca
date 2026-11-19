import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { PhoneBot } from './host-bots-operations'
import type * as HostBotsReadModule from './host-bots-read'
import { DEFAULT_BOT_SIDEBAR_VIEW } from '../../../src/shared/bots/bot-sidebar-view'
import type { HostBotsRead } from './host-bots-read'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))

const reads = vi.hoisted((): { answer: HostBotsRead | null; count: number } => ({
  answer: null,
  count: 0
}))

vi.mock('./host-bots-read', async (importOriginal) => {
  const actual = await importOriginal<typeof HostBotsReadModule>()
  const store = await import('./host-bot-store')
  return {
    ...actual,
    // The real read publishes to the store; so does this one, which is what restarted the effect.
    readHostBots: async (_client: RpcClient, key: string): Promise<HostBotsRead> => {
      reads.count += 1
      const answer = reads.answer ?? { kind: 'unreadable' }
      if (answer.kind === 'bots') {
        store.publishHostBots(key, answer)
      }
      return answer
    }
  }
})

vi.mock('./bot-avatar-uploads', () => ({ readBotAvatarUploads: async () => new Map() }))

const { useRouteBot } = await import('./use-route-bot')

const LISTED: HostBotsRead = {
  kind: 'bots',
  bots: [],
  hideBotCreated: true,
  view: DEFAULT_BOT_SIDEBAR_VIEW,
  enabled: true,
  takesCreate: true,
  takesTemplates: true,
  waits: {},
  needsYou: {}
}

const BOT: PhoneBot = {
  id: 'atlas',
  name: 'Atlas',
  folderWorkspaceId: 'atlas-home',
  avatar: null,
  paused: false,
  agent: 'claude',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null
}

const client: RpcClient = {
  sendRequest: async () => ({ id: 'a', ok: true, result: { activity: { workers: [] } } }),
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}

let tree: ReactTestRenderer | null = null
let shown: { reads: number; itemReads: number } | null = null
let activityError: string | null | undefined

function mount(hostKey: string, routeClient: RpcClient = client): void {
  function Route(): null {
    const route = useRouteBot({
      client: routeClient,
      connState: 'connected',
      worktreeId: 'folder:atlas-home',
      enabled: true,
      hostKey
    })
    shown = route ? { reads: route.reads, itemReads: route.itemReads } : null
    activityError = route?.activityError
    return null
  }
  act(() => {
    tree = create(createElement(Route))
  })
}

describe('useRouteBot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    reads.count = 0
  })
  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
    vi.useRealTimers()
  })

  it('stops reading a host without bots for phones', async () => {
    reads.answer = { kind: 'no-capability' }
    mount('host-old\nlocal')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(reads.count).toBe(1)
  })

  it("re-reads the bot on each of its pane's phase changes, but re-reads its items only on an items or workers notice", async () => {
    reads.answer = { ...LISTED, bots: [BOT] }
    let emit: (payload: unknown) => void = () => {}
    const streaming: RpcClient = {
      ...client,
      subscribe: (_method, _params, onData) => {
        emit = onData
        return () => {}
      }
    }
    const notice = async (kinds: string[]) => {
      emit({ type: 'botsChanged', botIds: [BOT.id], kinds })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
    }
    mount('host-notices\nlocal', streaming)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(reads.count).toBe(1)
    expect(shown).toEqual({ reads: 1, itemReads: 1 })
    await notice(['status'])
    expect(shown).toEqual({ reads: 2, itemReads: 1 })
    await notice(['items'])
    expect(shown).toEqual({ reads: 3, itemReads: 2 })
    await notice(['workers', 'status'])
    expect(shown).toEqual({ reads: 4, itemReads: 3 })
    // An older host's notice names nothing, so it may be items.
    emit({ type: 'botsChanged' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(shown).toEqual({ reads: 5, itemReads: 4 })
  })

  it("keeps the host's reason when it refuses the bot's Activity", async () => {
    reads.answer = { ...LISTED, bots: [BOT] }
    const refusing: RpcClient = {
      ...client,
      sendRequest: async () => ({
        id: 'a',
        ok: false,
        error: { code: 'runtime_error', message: 'Activity is still loading on the desktop.' }
      })
    }
    mount('host-refuses\nlocal', refusing)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(activityError).toBe('Activity is still loading on the desktop.')
  })
})
