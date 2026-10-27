import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  pathnames: string[]
  hostId: string | string[]
  refusals: number
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  pathnames: [],
  hostId: 'host-1',
  refusals: 0
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View'
}))

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ hostId: dependencies.hostId })
}))

vi.mock('./PageRouteUnavailableScreen', () => ({
  PageRouteUnavailableScreen: () => {
    dependencies.refusals += 1
    return null
  }
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

describe('the worktree-list route that hands off to the shell', () => {
  beforeEach(() => {
    dependencies.pathnames.length = 0
    dependencies.refusals = 0
    dependencies.hostId = 'host-1'
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

  it('refuses a dot-segment host id instead of handing over a route the page refuses', async () => {
    // Neither encodeURIComponent nor escaped dots can make a dot segment acceptable to the bridge.
    for (const hostId of ['..', '.']) {
      dependencies.hostId = hostId
      dependencies.pathnames.length = 0
      dependencies.refusals = 0
      await renderRoute()
      expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(`/h/${hostId}`), hostId).toBe(false)
      expect(dependencies.pathnames, hostId).toEqual([])
      expect(dependencies.refusals, hostId).toBeGreaterThan(0)
    }
  })

  it('opens the first of a repeated host id, never the pair joined into one', async () => {
    // Use firstParam for repeated Expo keys; encoding the array as a,b otherwise invents one valid but nonexistent host segment.
    dependencies.hostId = ['host-1', 'host-2']
    await renderRoute()
    expect(dependencies.pathnames).toEqual(['/h/host-1'])
  })

  it('refuses an empty repeated host id, which names no host at all', async () => {
    dependencies.hostId = []
    await renderRoute()
    expect(dependencies.pathnames).toEqual([])
    expect(dependencies.refusals).toBeGreaterThan(0)
  })
})
