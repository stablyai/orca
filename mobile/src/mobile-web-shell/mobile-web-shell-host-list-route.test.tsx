import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  storage: Map<string, string>
  pathnames: string[]
  hostId: string
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  storage: new Map(),
  pathnames: [],
  hostId: 'host-1'
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => dependencies.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      dependencies.storage.set(key, value)
    }
  }
}))

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ hostId: dependencies.hostId })
}))

vi.mock('../components/WorkspaceDetailPlaceholder', () => ({
  WorkspaceDetailPlaceholder: () => null
}))

vi.mock('../host-screen/HostScreen', () => ({ HostScreen: () => null }))

vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isWideLayout: false })
}))

vi.mock('./MobileWebShellScreen', () => ({
  MobileWebShellScreen: (props: { hostId: string; route: { pathname: string } }) => {
    dependencies.pathnames.push(props.route.pathname)
    return null
  }
}))

import { BRIDGE_ROUTE_PATHNAME_PATTERN } from './bridge/bridge-caps'
import HostWorktreeRoute from '../../app/h/[hostId]/index'

async function renderRoute(): Promise<void> {
  await act(async () => {
    create(createElement(HostWorktreeRoute))
  })
}

describe('the native worktree-list route that hands off to the shell', () => {
  beforeEach(() => {
    dependencies.storage.clear()
    dependencies.pathnames.length = 0
    dependencies.hostId = 'host-1'
    Object.assign(globalThis, { __DEV__: true })
    dependencies.storage.set('orca:mobileWebShellEnabled', 'true')
  })

  it('encodes the host id into the pathname, like the shell route already does', async () => {
    for (const hostId of ['a?b', 'a#b', 'a b', 'a/b', 'a\\b']) {
      dependencies.hostId = hostId
      dependencies.pathnames.length = 0
      await renderRoute()
      const pathname = dependencies.pathnames[0]
      expect(pathname, hostId).toBe(`/h/${encodeURIComponent(hostId)}`)
      expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(pathname ?? ''), hostId).toBe(true)
      expect(decodeURIComponent((pathname ?? '').slice('/h/'.length)), hostId).toBe(hostId)
    }
  })
})
