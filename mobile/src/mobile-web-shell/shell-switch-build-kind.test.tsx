import { createElement, type ComponentType } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type SwitchDependencies = {
  /** Committed mounts, not renders: what this file is about is what the user was shown. */
  natives: string[]
  shells: string[]
  params: Record<string, string | string[] | undefined>
}

const dependencies = vi.hoisted((): SwitchDependencies => ({
  natives: [],
  shells: [],
  params: {}
}))

const nativeScreen = vi.hoisted(
  () =>
    async (name: string): Promise<ComponentType<Record<string, unknown>>> => {
      const React = await import('react')
      return function NativeScreen() {
        React.useEffect(() => {
          dependencies.natives.push(name)
        }, [])
        return null
      }
    }
)

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View'
}))

vi.mock('expo-router', () => ({
  Redirect: 'Redirect',
  useLocalSearchParams: () => dependencies.params,
  useRouter: () => ({ setParams: () => {} })
}))

vi.mock('./MobileWebShellScreen', async () => {
  const React = await import('react')
  return {
    MobileWebShellScreen: (props: { route: { pathname: string } }) => {
      const pathname = React.useRef(props.route.pathname)
      React.useEffect(() => {
        dependencies.shells.push(pathname.current)
      }, [])
      return null
    }
  }
})

vi.mock('../host-screen/HostScreen', async () => ({ HostScreen: await nativeScreen('host-list') }))
vi.mock('../components/WorkspaceDetailPlaceholder', async () => ({
  WorkspaceDetailPlaceholder: await nativeScreen('workspace-detail-placeholder')
}))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isWideLayout: false })
}))
vi.mock('../tasks/MobileTasksScreen', async () => ({
  MobileTasksScreen: await nativeScreen('tasks')
}))
vi.mock('../agent-history/MobileAgentSessionHistoryPanel', async () => ({
  MobileAgentSessionHistoryPanel: await nativeScreen('agent-history')
}))
vi.mock('../files/MobileFileExplorerPanel', async () => ({
  MobileFileExplorerPanel: await nativeScreen('files')
}))
vi.mock('../files/MobileFilePreviewScreen', async () => ({
  MobileFilePreviewScreen: await nativeScreen('files-preview')
}))
vi.mock('../source-control/MobileSourceControlPanel', async () => ({
  MobileSourceControlPanel: await nativeScreen('source-control')
}))
vi.mock('../session/MobileDiffReviewRouteScreen', async () => ({
  MobileDiffReviewRouteScreen: await nativeScreen('review')
}))
vi.mock('../session/MobileSessionRouteScreen', async () => ({
  MobileSessionRouteScreen: await nativeScreen('session')
}))
vi.mock('./PageRouteUnavailableScreen', async () => ({
  PageRouteUnavailableScreen: await nativeScreen('catch-all')
}))

import HostListRoute from '../../app/h/[hostId]/index'
import TasksRoute from '../../app/h/[hostId]/tasks'
import AgentHistoryRoute from '../../app/h/[hostId]/agent-history/[worktreeId]'
import FilesRoute from '../../app/h/[hostId]/files/[worktreeId]'
import FilesPreviewRoute from '../../app/h/[hostId]/files/preview/[worktreeId]'
import SourceControlRoute from '../../app/h/[hostId]/source-control/[worktreeId]'
import ReviewRoute from '../../app/h/[hostId]/review/[worktreeId]'
import SessionRoute from '../../app/h/[hostId]/session/[worktreeId]'
import CatchAllRoute from './catch-all-page-route'

/**
 * Every switch the build kind decides, with the params each needs to name a route the shell could
 * open. `native` is what that switch renders outside an OTA build — a panel for most of them and the
 * refusal screen for the catch-all, which has no native screen behind it.
 */
type SwitchCase = {
  readonly name: string
  readonly Route: ComponentType
  readonly params: Record<string, string | string[]>
  /** What the mocked native screen pushes when it mounts. */
  readonly native: string
  readonly pathname: string
}

const SWITCHES: readonly SwitchCase[] = [
  {
    name: 'host list',
    Route: HostListRoute,
    params: { hostId: 'host-1' },
    native: 'host-list',
    pathname: '/h/host-1'
  },
  {
    name: 'tasks',
    Route: TasksRoute,
    params: { hostId: 'host-1' },
    native: 'tasks',
    pathname: '/h/host-1/tasks'
  },
  {
    name: 'agent history',
    Route: AgentHistoryRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    native: 'agent-history',
    pathname: '/h/host-1/agent-history/wt-1'
  },
  {
    name: 'files',
    Route: FilesRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    native: 'files',
    pathname: '/h/host-1/files/wt-1'
  },
  {
    name: 'file preview',
    Route: FilesPreviewRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1', relativePath: 'src/index.ts' },
    native: 'files-preview',
    pathname: '/h/host-1/files/preview/wt-1'
  },
  {
    name: 'source control',
    Route: SourceControlRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    native: 'source-control',
    pathname: '/h/host-1/source-control/wt-1'
  },
  {
    name: 'review',
    Route: ReviewRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    native: 'review',
    pathname: '/h/host-1/review/wt-1'
  },
  {
    name: 'session',
    Route: SessionRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    native: 'session',
    pathname: '/h/host-1/session/wt-1'
  },
  {
    name: 'catch-all',
    Route: CatchAllRoute,
    params: { hostId: 'host-1', page: ['settings'] },
    native: 'catch-all',
    pathname: '/h/host-1/settings'
  }
]

/** A synchronous `act` commits the first frame and its mount effects, and nothing async after it. */
function renderFirstFrame(Route: ComponentType): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(createElement(Route))
  })
  if (rendered.tree === null) {
    throw new Error('the switch did not render')
  }
  return rendered.tree
}

describe.each(SWITCHES)('the $name switch', (entry) => {
  beforeEach(() => {
    dependencies.natives.length = 0
    dependencies.shells.length = 0
    dependencies.params = { ...entry.params }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('commits the shell on its first frame in an OTA build, and never native', async () => {
    vi.stubEnv('EXPO_PUBLIC_MOBILE_SHELL', 'ota')
    renderFirstFrame(entry.Route)
    expect(dependencies.shells).toEqual([entry.pathname])
    await act(async () => {})
    expect(dependencies.natives).toEqual([])
    expect(dependencies.shells).toEqual([entry.pathname])
  })

  it('commits native on its first frame in any other build, and never the shell', async () => {
    vi.stubEnv('EXPO_PUBLIC_MOBILE_SHELL', undefined)
    renderFirstFrame(entry.Route)
    expect(dependencies.natives).toEqual([entry.native])
    await act(async () => {})
    expect(dependencies.natives).toEqual([entry.native])
    expect(dependencies.shells).toEqual([])
  })
})
