import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { getNotificationNavigationTarget } from './notification-routing'
import {
  hostStackHostRoute,
  navigateToHostStackRoute,
  type HostStackNavigationState
} from '../navigation/host-stack-navigation'
import { useMobileNativeChatInputLease } from '../session/use-mobile-native-chat-input-lease'
import { useOpenNotificationRoute } from './use-open-notification-route'

const navigationHooks = vi.hoisted(() => ({ navigation: null as unknown, router: null as unknown }))
vi.mock('expo-router', () => ({
  useNavigation: () => navigationHooks.navigation,
  useRouter: () => navigationHooks.router
}))

const rootLayoutSource = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8')
const HOST_ID = 'host/one'
const WORKTREE_ID = 'repo::/Users/me/orca/workspaces/feature'

type TestRendererHandle = Readonly<{
  unmount: () => void
  update: (element: unknown) => void
}>

function navigationHarness(initialState: HostStackNavigationState | undefined) {
  const stateListeners = new Set<() => void>()
  let state = initialState
  const navigation = {
    addListener: vi.fn((_event: 'state', listener: () => void) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    }),
    dispatch: vi.fn(),
    getState: () => state
  }
  return {
    navigation,
    listenerCount: () => stateListeners.size,
    setState(nextState: HostStackNavigationState | undefined) {
      state = nextState
      for (const listener of stateListeners) {
        listener()
      }
    }
  }
}

// A notification tap is handled by app/_layout.tsx, which Expo Router mounts as a screen of its
// own internal navigator — hence the extra `__root` level around the app's root stack.
function rootLayoutScopedState(inner: HostStackNavigationState): HostStackNavigationState {
  return { key: 'internal', index: 0, routes: [{ key: '__root', name: '__root', state: inner }] }
}

function committedSessionState(
  hostId = HOST_ID,
  worktreeId = WORKTREE_ID,
  hostContainerId?: string
) {
  return rootLayoutScopedState({
    index: 1,
    routes: [
      { name: 'index' },
      {
        name: 'h',
        params: hostContainerId === undefined ? undefined : { hostId: hostContainerId },
        state: {
          key: '/h',
          index: 0,
          routes: [
            {
              key: 'session',
              name: '[hostId]/session/[worktreeId]',
              params: {
                hostId,
                worktreeId,
                name: 'Feature',
                created: '1',
                warning: 'Workspace creation used a fallback'
              }
            }
          ]
        }
      }
    ]
  })
}

describe('notification route coordination', () => {
  it('mounts the host before replacing it with the notification session, from a cold navigator', () => {
    const target = getNotificationNavigationTarget({
      hostId: 'host/one',
      worktreeId: 'repo::/Users/me/orca/workspaces/feature'
    })
    // Cold start: the tap is handled before the root navigator has committed any state.
    const harness = navigationHarness(undefined)
    const push = vi.fn()

    navigateToHostStackRoute(
      harness.navigation,
      { push, replace: vi.fn() },
      target!.hostId,
      target!.sessionTarget!
    )

    expect(push).toHaveBeenCalledWith(hostStackHostRoute('host/one'))
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()

    harness.setState(rootLayoutScopedState({ index: 0, routes: [{ name: 'index' }] }))
    harness.setState(
      rootLayoutScopedState({
        index: 1,
        routes: [{ name: 'index' }, { name: 'h', state: undefined }]
      })
    )
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()

    harness.setState(
      rootLayoutScopedState({
        index: 1,
        routes: [
          { name: 'index' },
          {
            name: 'h',
            state: {
              key: '/h',
              index: 0,
              routes: [
                {
                  key: 'host-index',
                  name: '[hostId]/index',
                  params: { hostId: encodeURIComponent('host/one') }
                }
              ]
            }
          }
        ]
      })
    )

    expect(harness.navigation.dispatch).toHaveBeenCalledWith({
      type: 'REPLACE',
      target: '/h',
      source: 'host-index',
      payload: target!.sessionTarget
    })
  })

  it('keeps the exact cache and input lease sendable across repeated same-session taps', async () => {
    type Lease = ReturnType<typeof useMobileNativeChatInputLease>
    let lease: Lease | null = null
    function LeaseHarness(): null {
      lease = useMobileNativeChatInputLease({ activeHandle: 'terminal-1', connected: true })
      return null
    }

    let renderer: TestRendererHandle | null = null
    await act(async () => {
      renderer = create(createElement(LeaseHarness))
    })
    act(() => lease?.markReady('terminal-1'))

    const readyRef = lease!.readyRef
    const cachedTerminal = { handle: 'terminal-1' }
    const terminalCache = new Map([['terminal-1', cachedTerminal]])
    const clearTerminalCache = vi.fn(() => {
      terminalCache.clear()
      lease?.clear()
    })
    const detach = vi.fn(() => act(clearTerminalCache))
    const harness = navigationHarness(
      committedSessionState(HOST_ID, WORKTREE_ID, encodeURIComponent(HOST_ID))
    )
    const router = { push: vi.fn(detach), replace: vi.fn(detach) }
    const target = getNotificationNavigationTarget({ hostId: HOST_ID, worktreeId: WORKTREE_ID })!
    navigationHooks.navigation = harness.navigation
    navigationHooks.router = router

    let openNotificationRoute: ReturnType<typeof useOpenNotificationRoute> | null = null
    function NotificationHookHarness(): null {
      openNotificationRoute = useOpenNotificationRoute()
      return null
    }

    let notificationRenderer: TestRendererHandle | null = null
    await act(async () => {
      notificationRenderer = create(createElement(NotificationHookHarness))
    })

    act(() => openNotificationRoute?.(target))
    act(() => openNotificationRoute?.(target))

    expect.soft(router.push).not.toHaveBeenCalled()
    expect.soft(router.replace).not.toHaveBeenCalled()
    expect.soft(harness.navigation.dispatch).not.toHaveBeenCalled()
    expect.soft(harness.listenerCount()).toBe(0)
    expect.soft(detach).not.toHaveBeenCalled()
    expect.soft(clearTerminalCache).not.toHaveBeenCalled()
    expect.soft(terminalCache.get('terminal-1')).toBe(cachedTerminal)
    expect.soft(lease!.readyRef).toBe(readyRef)
    expect.soft(lease!.ready).toBe(true)
    expect.soft(lease!.lockReason).toBeNull()
    expect.soft(lease!.lockReason !== null).toBe(false)

    act(() => notificationRenderer?.unmount())
    act(() => renderer?.unmount())
  })

  it.each([
    ['different worktree', HOST_ID, 'repo::/Users/me/orca/workspaces/other'],
    ['different host', 'host/two', WORKTREE_ID]
  ])('transitions for a %s notification', (_label, hostId, worktreeId) => {
    const harness = navigationHarness(committedSessionState())
    const push = vi.fn()
    const target = getNotificationNavigationTarget({ hostId, worktreeId })!

    navigateToHostStackRoute(
      harness.navigation,
      { push, replace: vi.fn() },
      target.hostId,
      target.sessionTarget!
    )

    expect(push).toHaveBeenCalledOnce()
    expect(harness.listenerCount()).toBe(1)
  })

  it.each([
    ['missing worktree identity', committedSessionState(HOST_ID, '')],
    ['stale worktree identity', committedSessionState(HOST_ID, `${WORKTREE_ID}-stale`)],
    ['conflicting outer host identity', committedSessionState(HOST_ID, WORKTREE_ID, 'host/two')]
  ])('transitions when the focused route has %s', (_label, state) => {
    const harness = navigationHarness(state)
    const push = vi.fn()
    const target = getNotificationNavigationTarget({ hostId: HOST_ID, worktreeId: WORKTREE_ID })!

    navigateToHostStackRoute(
      harness.navigation,
      { push, replace: vi.fn() },
      target.hostId,
      target.sessionTarget!
    )

    expect(push).toHaveBeenCalledOnce()
  })

  it.each([
    [HOST_ID, 'repo::/tmp/a%2Fb', HOST_ID, 'repo::/tmp/a/b'],
    [HOST_ID, 'repo::/tmp/%41', HOST_ID, 'repo::/tmp/A'],
    ['host%2Fone', WORKTREE_ID, 'host/one', WORKTREE_ID]
  ])(
    'transitions when distinct raw identities only look equal after decoding',
    (focusedHostId, focusedWorktreeId, targetHostId, targetWorktreeId) => {
      const harness = navigationHarness(committedSessionState(focusedHostId, focusedWorktreeId))
      const push = vi.fn()
      const target = getNotificationNavigationTarget({
        hostId: targetHostId,
        worktreeId: targetWorktreeId
      })!

      navigateToHostStackRoute(
        harness.navigation,
        { push, replace: vi.fn() },
        target.hostId,
        target.sessionTarget!
      )

      expect(push).toHaveBeenCalledOnce()
      expect(harness.listenerCount()).toBe(1)
    }
  )

  it('disposes a canceled notification transition before a later host commit', () => {
    const harness = navigationHarness(
      rootLayoutScopedState({ index: 0, routes: [{ name: 'index' }] })
    )
    const target = getNotificationNavigationTarget({ hostId: HOST_ID, worktreeId: WORKTREE_ID })!
    const controller = navigateToHostStackRoute(
      harness.navigation,
      { push: vi.fn(), replace: vi.fn() },
      target.hostId,
      target.sessionTarget!
    )

    controller.cancel()
    harness.setState(committedSessionState())

    expect(controller.isActive()).toBe(false)
    expect(harness.listenerCount()).toBe(0)
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()
  })

  it('preserves a re-established lease when the same route is reconstructed after reconnect', async () => {
    type Lease = ReturnType<typeof useMobileNativeChatInputLease>
    let lease: Lease | null = null
    function LeaseHarness({ connected }: { connected: boolean }): null {
      lease = useMobileNativeChatInputLease({ activeHandle: 'terminal-1', connected })
      return null
    }

    let renderer: TestRendererHandle | null = null
    await act(async () => {
      renderer = create(createElement(LeaseHarness, { connected: false }))
    })
    await act(async () => {
      renderer?.update(createElement(LeaseHarness, { connected: true }))
    })
    act(() => lease?.markReady('terminal-1'))
    const readyRef = lease!.readyRef
    const harness = navigationHarness(committedSessionState())
    const target = getNotificationNavigationTarget({ hostId: HOST_ID, worktreeId: WORKTREE_ID })!

    navigateToHostStackRoute(
      harness.navigation,
      { push: vi.fn(() => act(() => lease?.clear())), replace: vi.fn() },
      target.hostId,
      target.sessionTarget!
    )

    expect.soft(lease!.readyRef).toBe(readyRef)
    expect.soft(lease!.ready).toBe(true)
    expect.soft(lease!.lockReason).toBeNull()
    act(() => renderer?.unmount())
  })

  it('leaves a host-only notification as a shallow push with nothing to coordinate', () => {
    expect(getNotificationNavigationTarget({ hostId: 'host-1' })?.sessionTarget).toBeNull()
  })

  it('routes notification taps through the coordinated transition, not a bare push', () => {
    const start = rootLayoutSource.indexOf('// ─── Notification tap routing ───')
    const end = rootLayoutSource.indexOf('// ─── End notification tap routing ───', start)

    // Assert the markers first: a renamed banner would otherwise slice garbage and report a
    // missing call instead of the real cause.
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    const notificationEffect = rootLayoutSource.slice(start, end)
    expect(notificationEffect).toContain('openNotificationRoute(target)')
    expect(notificationEffect).not.toContain('router.push(')
  })
})
