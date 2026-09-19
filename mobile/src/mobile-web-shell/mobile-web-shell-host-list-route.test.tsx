import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  storage: Map<string, string>
  pathnames: string[]
  hostId: string | string[]
  nativeRenders: number
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  storage: new Map(),
  pathnames: [],
  hostId: 'host-1',
  nativeRenders: 0
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

vi.mock('../host-screen/HostScreen', () => ({
  HostScreen: () => {
    dependencies.nativeRenders += 1
    return null
  }
}))

// `firstParam` lives beside the source-control screen state, which imports the lucide barrel, and
// that barrel's `LucideProvider` re-export is the gap the web build patches with a plugin. Nine
// icons, named as the other suites name theirs; none of them renders here.
vi.mock('lucide-react-native', () => ({
  ArrowDown: vi.fn(),
  ArrowDownUp: vi.fn(),
  ArrowUp: vi.fn(),
  Check: vi.fn(),
  CloudUpload: vi.fn(),
  GitBranch: vi.fn(),
  GitPullRequestArrow: vi.fn(),
  History: vi.fn(),
  RefreshCw: vi.fn()
}))

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
    dependencies.nativeRenders = 0
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

  it('keeps a dot-segment host id native instead of handing over a route the page refuses', async () => {
    // `encodeURIComponent` leaves a dot alone and `%2e%2e` is a dot segment to the URL parser too,
    // so this one cannot be encoded into a pathname the bridge accepts. Handed over it reaches the
    // phone as an `init` naming no screen and the page paints "Update Orca to open this
    // workspace" over the native list that is sitting right behind this switch.
    for (const hostId of ['..', '.']) {
      dependencies.hostId = hostId
      dependencies.pathnames.length = 0
      dependencies.nativeRenders = 0
      await renderRoute()
      expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(`/h/${hostId}`), hostId).toBe(false)
      expect(dependencies.pathnames, hostId).toEqual([])
      expect(dependencies.nativeRenders, hostId).toBeGreaterThan(0)
    }
  })

  it('opens the first of a repeated host id, never the pair joined into one', async () => {
    // Expo Router answers a repeated key with an array. Interpolated, `String(['a','b'])` is
    // `a,b` and `encodeURIComponent` makes that the single segment `a%2Cb`, which the bridge's
    // segment rule accepts — so the shell would open a page for a host nobody has.
    dependencies.hostId = ['host-1', 'host-2']
    await renderRoute()
    expect(dependencies.pathnames).toEqual(['/h/host-1'])
  })

  it('stays native for an empty repeated host id, which names no host at all', async () => {
    dependencies.hostId = []
    await renderRoute()
    expect(dependencies.pathnames).toEqual([])
    expect(dependencies.nativeRenders).toBeGreaterThan(0)
  })
})
