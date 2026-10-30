import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  routes: { pathname: string; params?: Record<string, string> }[]
  refusals: string[]
  lifecycle: string[]
  params: Record<string, string | string[] | undefined>
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  routes: [],
  refusals: [],
  lifecycle: [],
  params: {}
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View'
}))

vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: null, state: 'disconnected' })
}))
vi.mock('../transport/workspace-server', () => ({
  useWorkspaceServer: () => ({ routeHost: undefined, server: null })
}))
vi.mock('expo-router', () => ({ useLocalSearchParams: () => dependencies.params }))

vi.mock('./PageRouteUnavailableScreen', () => ({
  PageRouteUnavailableScreen: (props: { hostId: string }) => {
    dependencies.refusals.push(props.hostId)
    return null
  }
}))

vi.mock('./MobileWebShellScreen', async () => {
  const React = await import('react')
  return {
    MobileWebShellScreen: (props: {
      hostId: string
      route: { pathname: string; params?: Record<string, string> }
    }) => {
      dependencies.routes.push(props.route)
      // Keep deps empty: pathname-driven effects would also run on prop updates and falsely look like remounts.
      const mountedAs = React.useRef(props.route.pathname)
      React.useEffect(() => {
        const pathname = mountedAs.current
        dependencies.lifecycle.push(`mount:${pathname}`)
        return () => {
          dependencies.lifecycle.push(`unmount:${pathname}`)
        }
      }, [])
      return null
    }
  }
})

import { BRIDGE_ROUTE_PATHNAME_PATTERN } from './bridge/bridge-caps'
import MobileFileExplorerScreen from '../../app/h/[hostId]/files/[worktreeId]'
import MobileFilePreviewRoute from '../../app/h/[hostId]/files/preview/[worktreeId]'

async function renderExplorer(): Promise<void> {
  await act(async () => {
    create(createElement(MobileFileExplorerScreen))
  })
}

async function renderPreview(): Promise<void> {
  await act(async () => {
    create(createElement(MobileFilePreviewRoute))
  })
}

beforeEach(() => {
  dependencies.routes.length = 0
  dependencies.refusals.length = 0
  dependencies.lifecycle.length = 0
  dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1', name: 'my worktree' }
})

describe('the file explorer route that hands off to the shell', () => {
  it('opens the shell on this screen, with the name as the search half', async () => {
    await renderExplorer()
    expect(dependencies.routes).toEqual([
      { pathname: '/h/host-1/files/wt-1', params: { name: 'my worktree' } }
    ])
  })

  // Expo returns repeated query keys as arrays; firstParam avoids encoding a,b as one valid but nonexistent host segment.
  it('takes the first value of a repeated param, not the joined array', async () => {
    dependencies.params = {
      hostId: ['host-a', 'host-b'],
      worktreeId: ['wt-1', 'wt-2'],
      name: ['first', 'second']
    }
    await renderExplorer()
    expect(dependencies.routes).toEqual([
      { pathname: '/h/host-a/files/wt-1', params: { name: 'first' } }
    ])
    const pathname = dependencies.routes[0]?.pathname ?? ''
    expect(pathname).not.toContain('%2C')
    expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(pathname)).toBe(true)
  })

  it('refuses a dot-segment id the bridge would refuse', async () => {
    for (const hostId of ['.', '..']) {
      dependencies.params = { hostId, worktreeId: 'wt-1' }
      dependencies.routes.length = 0
      await renderExplorer()
      expect(dependencies.routes, hostId).toEqual([])
      expect(dependencies.refusals.at(-1), hostId).toBe(hostId)
    }
  })

  it('encodes both dynamic segments, so a deep-linked id stays one segment each', async () => {
    for (const hostId of ['a?b', 'a#b', 'a b', 'a/b', 'a\\b']) {
      dependencies.params = { hostId, worktreeId: 'wt/1' }
      dependencies.routes.length = 0
      await renderExplorer()
      const pathname = dependencies.routes[0]?.pathname ?? ''
      expect(pathname, hostId).toBe(
        `/h/${encodeURIComponent(hostId)}/files/${encodeURIComponent('wt/1')}`
      )
      expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(pathname), hostId).toBe(true)
    }
  })

  // Remount on route change to dispose the bridge that captured the previous route’s grants.
  it('remounts the shell when the route changes rather than updating it', async () => {
    let renderer: ReturnType<typeof create> | null = null
    await act(async () => {
      renderer = create(createElement(MobileFileExplorerScreen))
    })
    dependencies.params = { hostId: 'host-2', worktreeId: 'wt-9' }
    await act(async () => {
      renderer?.update(createElement(MobileFileExplorerScreen))
    })
    expect(dependencies.lifecycle).toEqual([
      'mount:/h/host-1/files/wt-1',
      'unmount:/h/host-1/files/wt-1',
      'mount:/h/host-2/files/wt-9'
    ])
  })

  it('remounts when only a param changes, which the page has no other way to learn', async () => {
    // Labels affect initial route state too; include params in remount identity so the page receives the new value.
    let renderer: ReturnType<typeof create> | null = null
    await act(async () => {
      renderer = create(createElement(MobileFileExplorerScreen))
    })
    dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1', name: 'renamed' }
    await act(async () => {
      renderer?.update(createElement(MobileFileExplorerScreen))
    })
    expect(dependencies.lifecycle).toEqual([
      'mount:/h/host-1/files/wt-1',
      'unmount:/h/host-1/files/wt-1',
      'mount:/h/host-1/files/wt-1'
    ])
  })
})

describe('the file preview route that hands off to the shell', () => {
  beforeEach(() => {
    dependencies.params = {
      hostId: 'host-1',
      worktreeId: 'wt-1',
      relativePath: 'docs/readme.md'
    }
  })

  it('opens the shell on this screen, with the file path as a param', async () => {
    await renderPreview()
    expect(dependencies.routes).toEqual([
      {
        pathname: '/h/host-1/files/preview/wt-1',
        params: { relativePath: 'docs/readme.md', source: 'worktree' }
      }
    ])
  })

  it('remounts for another file in the same worktree, which keeps the pathname', async () => {
    let renderer: ReturnType<typeof create> | null = null
    await act(async () => {
      renderer = create(createElement(MobileFilePreviewRoute))
    })
    dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1', relativePath: 'docs/other.md' }
    await act(async () => {
      renderer?.update(createElement(MobileFilePreviewRoute))
    })
    expect(dependencies.lifecycle).toEqual([
      'mount:/h/host-1/files/preview/wt-1',
      'unmount:/h/host-1/files/preview/wt-1',
      'mount:/h/host-1/files/preview/wt-1'
    ])
    expect(dependencies.routes.at(-1)?.params?.relativePath).toBe('docs/other.md')
  })

  it('remounts the shell when the route changes rather than updating it', async () => {
    let renderer: ReturnType<typeof create> | null = null
    await act(async () => {
      renderer = create(createElement(MobileFilePreviewRoute))
    })
    dependencies.params = { hostId: 'host-2', worktreeId: 'wt-9', relativePath: 'a.md' }
    await act(async () => {
      renderer?.update(createElement(MobileFilePreviewRoute))
    })
    expect(dependencies.lifecycle).toEqual([
      'mount:/h/host-1/files/preview/wt-1',
      'unmount:/h/host-1/files/preview/wt-1',
      'mount:/h/host-2/files/preview/wt-9'
    ])
  })
})
