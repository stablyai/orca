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
vi.mock('../worktree/workspace-server', () => ({
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

  it('refuses a dot-segment id the bridge would refuse', async () => {
    for (const hostId of ['.', '..']) {
      dependencies.params = { hostId, worktreeId: 'wt-1' }
      dependencies.routes.length = 0
      await renderExplorer()
      expect(dependencies.routes, hostId).toEqual([])
      expect(dependencies.refusals.at(-1), hostId).toBe(hostId)
    }
  })

  // Remount on route change to dispose the bridge that captured the previous route’s grants.
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
})
