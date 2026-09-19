import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RouteDependencies = {
  storage: Map<string, string>
  routes: { pathname: string; params?: Record<string, string> }[]
  panels: { hostId: string; worktreeId: string; name?: string }[]
  previews: unknown[]
  /** `mount:<pathname>` / `unmount:<pathname>`, which is the only thing that tells a remount from
   *  a prop update — and a remount is what drops the old session's bridge and its grants. */
  lifecycle: string[]
  params: Record<string, string | string[] | undefined>
}

const dependencies = vi.hoisted((): RouteDependencies => ({
  storage: new Map(),
  routes: [],
  panels: [],
  previews: [],
  lifecycle: [],
  params: {}
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => dependencies.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      dependencies.storage.set(key, value)
    }
  }
}))

vi.mock('expo-router', () => ({ useLocalSearchParams: () => dependencies.params }))

// `firstParam` lives in the source-control barrel, which imports two dozen icons from a 1.14.0
// lucide barrel that re-exports a `LucideProvider` its own context.mjs does not have. Metro and the
// web builder each paper over it; nothing under test here renders an icon, so any name will do.
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

vi.mock('../files/MobileFileExplorerPanel', () => ({
  MobileFileExplorerPanel: (props: { hostId: string; worktreeId: string; name?: string }) => {
    dependencies.panels.push(props)
    return null
  }
}))

vi.mock('../files/MobileFilePreviewScreen', () => ({
  MobileFilePreviewScreen: (props: unknown) => {
    dependencies.previews.push(props)
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
      // Empty deps on purpose: keyed on the pathname this would re-fire on a prop update and read
      // exactly like a remount, which is the one thing it exists to tell apart.
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
  dependencies.storage.clear()
  dependencies.routes.length = 0
  dependencies.panels.length = 0
  dependencies.previews.length = 0
  dependencies.lifecycle.length = 0
  dependencies.params = { hostId: 'host-1', worktreeId: 'wt-1', name: 'my worktree' }
  Object.assign(globalThis, { __DEV__: true })
  dependencies.storage.set('orca:mobileWebShellEnabled', 'true')
})

describe('the native file explorer route that hands off to the shell', () => {
  it('opens the shell on this screen, with the name as the search half', async () => {
    await renderExplorer()
    expect(dependencies.routes).toEqual([
      { pathname: '/h/host-1/files/wt-1', params: { name: 'my worktree' } }
    ])
  })

  it('renders the native panel while the flag read is still settling', async () => {
    await renderExplorer()
    expect(dependencies.panels[0]).toEqual({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      name: 'my worktree',
      embedded: false
    })
  })

  /**
   * A repeated query key, which expo-router answers with an array.
   *
   * A bare read puts that array straight into a template, where `String(['a','b'])` is `a,b` and
   * `encodeURIComponent` makes it `a%2Cb` — one segment, so the bridge's segment rule accepts it
   * and the shell opens a page for a host that does not exist. `firstParam` is what the other
   * switches read through, and it takes the first value the way the native screen below does.
   */
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

  it('stays native for a dot-segment id the bridge would refuse', async () => {
    for (const hostId of ['.', '..']) {
      dependencies.params = { hostId, worktreeId: 'wt-1' }
      dependencies.routes.length = 0
      await renderExplorer()
      expect(dependencies.routes, hostId).toEqual([])
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

  it('renders the native panel with the flag off, which is every store build', async () => {
    dependencies.storage.set('orca:mobileWebShellEnabled', 'false')
    await renderExplorer()
    expect(dependencies.routes).toEqual([])
  })

  /**
   * A route change is a new session, and the old one's bridge must not outlive it.
   *
   * The host captures the grants its session was opened with, so a screen reused across a route
   * change keeps authorising frames under the grants of the route the page has left. Only a
   * remount drops it, and only a key guarantees one.
   */
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
    // The page reads its route once, out of `init`. Same pathname, different label: without the
    // params in the key the shell stays mounted and the page never hears about it.
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

describe('the native file preview route that hands off to the shell', () => {
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
