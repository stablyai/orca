import { createElement, type ComponentType } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type SwitchDependencies = {
  storage: Map<string, string>
  /** What bounds the neutral window on a released phone; see the last case in this file. */
  reads: number
  /** Committed mounts, not renders: React may discard a render, and what this file is about is
   *  what the user was shown. */
  natives: string[]
  shells: string[]
  /** Committed mounts of the neutral screen, which is what "never paints a neutral frame" needs:
   *  a frame committed and replaced inside one `act` leaves nothing in the final tree. */
  neutrals: number
  params: Record<string, string | string[] | undefined>
}

const dependencies = vi.hoisted((): SwitchDependencies => ({
  storage: new Map(),
  reads: 0,
  natives: [],
  shells: [],
  neutrals: 0,
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
  default: {
    getItem: async (key: string) => {
      dependencies.reads += 1
      return dependencies.storage.get(key) ?? null
    },
    setItem: async (key: string, value: string) => {
      dependencies.storage.set(key, value)
    }
  }
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
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

vi.mock('./ShellSwitchPendingScreen', async () => {
  const React = await import('react')
  return {
    ShellSwitchPendingScreen: () => {
      React.useEffect(() => {
        dependencies.neutrals += 1
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

const FLAG_KEY = 'orca:mobileWebShellEnabled'

/**
 * Every switch the hybrid shell flag decides, with the params each needs to name a route the shell
 * could open. `native` is what that switch renders when the flag is off — a panel for most of them
 * and the refusal screen for the catch-all, which has no native screen behind it.
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

/**
 * `__DEV__` is a React Native global with no value under this runner, so every case pins it rather
 * than inheriting one: assigned onto `globalThis` for a build kind that has it and deleted for a
 * store build, which is what the app sees when the bundler defined nothing. Which one is in force
 * decides whether the neutral state is reachable at all, so an unpinned case would be measuring
 * the runner.
 */
function setDevelopmentBuild(isDevelopmentBuild: boolean | undefined): void {
  if (isDevelopmentBuild === undefined) {
    Reflect.deleteProperty(globalThis, '__DEV__')
    return
  }
  Object.assign(globalThis, { __DEV__: isDevelopmentBuild })
}

/** Renders without settling the flag read: no `await` inside `act`, so the effect's promise is
 *  deliberately left pending and the switch is caught in its unresolved window. */
function renderUnsettled(Route: ComponentType): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(createElement(Route))
  })
  if (rendered.tree === null) {
    throw new Error('the switch did not render')
  }
  return rendered.tree
}

describe.each(SWITCHES)('the $name switch on a development build', (entry) => {
  beforeEach(() => {
    dependencies.storage.clear()
    dependencies.reads = 0
    dependencies.natives.length = 0
    dependencies.shells.length = 0
    dependencies.neutrals = 0
    dependencies.params = { ...entry.params }
    setDevelopmentBuild(true)
  })

  it('mounts neither renderer while the flag is unresolved, and paints the neutral state', async () => {
    dependencies.storage.set(FLAG_KEY, 'true')
    renderUnsettled(entry.Route)
    expect(dependencies.natives).toEqual([])
    expect(dependencies.shells).toEqual([])
    expect(dependencies.neutrals).toBe(1)
    await act(async () => {})
  })

  it('mounts the shell once when the read resolves on, having never mounted native', async () => {
    dependencies.storage.set(FLAG_KEY, 'true')
    renderUnsettled(entry.Route)
    await act(async () => {})
    expect(dependencies.natives).toEqual([])
    expect(dependencies.shells).toEqual([entry.pathname])
  })

  it('mounts native once when the read resolves off, and nothing else', async () => {
    renderUnsettled(entry.Route)
    await act(async () => {})
    expect(dependencies.natives).toEqual([entry.native])
    expect(dependencies.shells).toEqual([])
  })
})

/**
 * The build every store user is on, where the flag cannot be turned on at all.
 *
 * A neutral frame is worth a native mount only when the flag could resolve on. Outside `__DEV__`
 * it cannot, so the hook holds `false` from its first render and the `pending` branch is
 * unreachable here: the switch commits the native renderer on frame one and never revises it.
 */
describe.each(SWITCHES)('the $name switch on a release build', (entry) => {
  beforeEach(() => {
    dependencies.storage.clear()
    dependencies.reads = 0
    dependencies.natives.length = 0
    dependencies.shells.length = 0
    dependencies.neutrals = 0
    dependencies.params = { ...entry.params }
    setDevelopmentBuild(false)
  })

  it('commits native on its first frame and never mounts the neutral screen', async () => {
    // A flag a development build left in the container, which a store build shares a bundle id
    // with: still unreachable, and still no neutral frame in front of it.
    dependencies.storage.set(FLAG_KEY, 'true')
    renderUnsettled(entry.Route)
    expect(dependencies.neutrals).toBe(0)
    expect(dependencies.natives).toEqual([entry.native])
    expect(dependencies.shells).toEqual([])
    await act(async () => {
      await Promise.resolve()
    })
    expect(dependencies.neutrals).toBe(0)
    expect(dependencies.natives).toEqual([entry.native])
    expect(dependencies.shells).toEqual([])
  })

  it('reaches no storage at all, which is what makes the first frame decidable', async () => {
    // The same fact the initialiser rests on: `loadMobileWebShellEnabled` answers `false` outside
    // `__DEV__` before it looks at the key, so there is nothing to wait for and nothing to read.
    dependencies.storage.set(FLAG_KEY, 'true')
    renderUnsettled(entry.Route)
    await act(async () => {
      await Promise.resolve()
    })
    expect(dependencies.reads).toBe(0)
  })

  it('does the same when the bundler defined no `__DEV__` at all', async () => {
    setDevelopmentBuild(undefined)
    dependencies.storage.set(FLAG_KEY, 'true')
    renderUnsettled(entry.Route)
    expect(dependencies.neutrals).toBe(0)
    expect(dependencies.natives).toEqual([entry.native])
    await act(async () => {})
  })
})
