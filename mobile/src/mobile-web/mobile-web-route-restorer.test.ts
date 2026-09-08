import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebNativeShellState } from '../../../src/mobile-web/src/native-shell-channel'
import type { MobileWebNavigationRoute } from '../../../src/shared/mobile-web/bridge-contract'
import { MobileWebRouteRestorer } from '../../host-web-app/mobile-web-route-restorer'
import { mobileWebRouteQuery } from './mobile-web-route-query-cache'

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  pathname: '/',
  shell: null as MobileWebNativeShellState | null
}))

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  usePathname: () => mocks.pathname
}))

vi.mock('../../../src/mobile-web/src/native-shell-channel', () => ({
  useMobileWebNativeShell: () => mocks.shell
}))

describe('MobileWebRouteRestorer', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    mocks.replace.mockReset()
    mocks.pathname = '/'
    mocks.shell = shellState('workspace-one', 'Workspace one', 1)
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('restores once per trusted route revision and again for a new shell context', () => {
    renderRestorer()
    expect(mocks.replace).toHaveBeenCalledTimes(1)
    expect(mocks.replace).toHaveBeenLastCalledWith(
      '/h/paired-orca-desktop/session/workspace-one?name=Workspace+one'
    )
    expect(mobileWebRouteQuery('/h/paired-orca-desktop/session/workspace-one')).toEqual({
      name: 'Workspace one'
    })

    mocks.shell = shellState('page-owned-route', 'Page route', 1)
    renderRestorer()
    expect(mocks.replace).toHaveBeenCalledTimes(1)

    mocks.shell = shellState('workspace-two', 'Workspace two', 2)
    renderRestorer()
    expect(mocks.replace).toHaveBeenCalledTimes(2)
    expect(mocks.replace).toHaveBeenLastCalledWith(
      '/h/paired-orca-desktop/session/workspace-two?name=Workspace+two'
    )

    mocks.shell = {
      ...shellState('ignored', 'Ignored', 3),
      navigationRoute: { kind: 'workspaceList' },
      resumeRoute: { kind: 'workspaceList' }
    }
    renderRestorer()
    expect(mocks.replace).toHaveBeenCalledTimes(3)
    expect(mocks.replace).toHaveBeenLastCalledWith('/')

    mocks.shell = {
      ...shellState('workspace-three', 'Workspace three', 1),
      context: {
        shellSessionId: 'T'.repeat(43),
        buildId: 'b'.repeat(64)
      }
    }
    renderRestorer()
    expect(mocks.replace).toHaveBeenCalledTimes(4)
  })

  it('restores hosted settings after a page swap and falls back for unknown rollback state', () => {
    mocks.shell = {
      ...shellState('workspace-one', 'Workspace one', 1),
      pageState: JSON.stringify({ version: 1, pathname: '/native-chat-settings' })
    }
    renderRestorer()
    expect(mocks.replace).toHaveBeenLastCalledWith('/native-chat-settings')

    mocks.shell = {
      ...shellState('workspace-one', 'Workspace one', 2),
      pageState: JSON.stringify({ version: 2, pathname: '/future-settings' })
    }
    renderRestorer()
    expect(mocks.replace).toHaveBeenLastCalledWith(
      '/h/paired-orca-desktop/session/workspace-one?name=Workspace+one'
    )
  })

  it('does not overwrite the saved page while the router is applying restoration', () => {
    const rememberRoute = vi.fn()
    const pageState = JSON.stringify({ version: 1, pathname: '/native-chat-settings' })
    mocks.shell = { ...shellState('workspace-one', 'Workspace one', 1), pageState, rememberRoute }
    renderRestorer()
    expect(rememberRoute).not.toHaveBeenCalled()
    mocks.pathname = '/native-chat-settings'
    renderRestorer()
    expect(rememberRoute).not.toHaveBeenCalled()
    mocks.pathname = '/'
    renderRestorer()
    expect(rememberRoute).toHaveBeenCalledWith(mocks.shell.resumeRoute, undefined)
  })

  it('remembers new hosted settings without changing the legacy fallback', () => {
    const rememberRoute = vi.fn()
    mocks.shell = { ...shellState('workspace-one', 'Workspace one', 1), rememberRoute }
    mocks.pathname = '/h/paired-orca-desktop/session/workspace-one'
    renderRestorer()
    mocks.pathname = '/browser-settings'
    renderRestorer()
    expect(rememberRoute).toHaveBeenCalledWith(
      mocks.shell.resumeRoute,
      JSON.stringify({ version: 1, pathname: '/browser-settings' })
    )
  })

  it('restores Tasks state and Accounts through queryless hosted history', () => {
    mocks.shell = navigationShellState({ kind: 'tasks', taskSource: 'gitlab' }, 1)
    renderRestorer()

    expect(mocks.replace).toHaveBeenLastCalledWith('/h/paired-orca-desktop/tasks?taskSource=gitlab')
    expect(mobileWebRouteQuery('/h/paired-orca-desktop/tasks')).toEqual({
      taskSource: 'gitlab'
    })

    mocks.shell = navigationShellState({ kind: 'accounts' }, 2)
    renderRestorer()

    expect(mocks.replace).toHaveBeenLastCalledWith('/h/paired-orca-desktop/accounts')
    expect(mobileWebRouteQuery('/h/paired-orca-desktop/accounts')).toEqual({})
  })

  function renderRestorer(): void {
    act(() => {
      if (renderer) {
        renderer.update(createElement(MobileWebRouteRestorer))
      } else {
        renderer = create(createElement(MobileWebRouteRestorer))
      }
    })
  }
})

function shellState(
  workspaceId: string,
  workspaceName: string,
  routeRevision: number
): MobileWebNativeShellState {
  const route = { kind: 'session' as const, workspaceId, workspaceName }
  return {
    client: null,
    context: {
      shellSessionId: 'S'.repeat(43),
      buildId: 'a'.repeat(64)
    },
    connection: 'connected',
    reconnectAttempts: 0,
    lastConnectedAt: Date.now(),
    navigationRoute: route,
    resumeRoute: route,
    routeRevision,
    rememberRoute: () => true
  }
}

function navigationShellState(
  navigationRoute: MobileWebNavigationRoute,
  routeRevision: number
): MobileWebNativeShellState {
  return {
    ...shellState('workspace-one', 'Workspace one', routeRevision),
    navigationRoute,
    resumeRoute: { kind: 'workspaceList' }
  }
}
