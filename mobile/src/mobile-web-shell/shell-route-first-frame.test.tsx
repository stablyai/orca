import { createElement, type ComponentType } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type SwitchDependencies = {
  /** Committed mounts, not renders: what this file is about is what the user was shown. */
  refusals: number
  shells: string[]
  params: Record<string, string | string[] | undefined>
}

const dependencies = vi.hoisted((): SwitchDependencies => ({
  refusals: 0,
  shells: [],
  params: {}
}))

const refusalScreen = vi.hoisted(
  () => async (): Promise<ComponentType<Record<string, unknown>>> => {
    const React = await import('react')
    return function RefusalScreen() {
      React.useEffect(() => {
        dependencies.refusals += 1
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

// The workspace route reads the desktop's connection to decide whether a server is reachable.
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: null, state: 'disconnected' })
}))
vi.mock('../transport/workspace-server', () => ({
  useWorkspaceServer: () => ({ routeHost: undefined, server: null })
}))
vi.mock('expo-router', () => ({
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

vi.mock('./PageRouteUnavailableScreen', async () => ({
  PageRouteUnavailableScreen: await refusalScreen()
}))

import HostListRoute from '../../app/h/[hostId]/index'
import TasksRoute from '../../app/h/[hostId]/tasks'
import AccountsRoute from '../../app/h/[hostId]/accounts'
import AgentHistoryRoute from '../../app/h/[hostId]/agent-history/[worktreeId]'
import FilesRoute from '../../app/h/[hostId]/files/[worktreeId]'
import FilesPreviewRoute from '../../app/h/[hostId]/files/preview/[worktreeId]'
import SourceControlRoute from '../../app/h/[hostId]/source-control/[worktreeId]'
import ReviewRoute from '../../app/h/[hostId]/review/[worktreeId]'
import SessionRoute from '../../app/h/[hostId]/session/[worktreeId]'
import CatchAllRoute from './catch-all-page-route'

/**
 * Every route switch, with params naming a route the shell could open and params naming none (which
 * get the refusal screen).
 */
type SwitchCase = {
  readonly name: string
  readonly Route: ComponentType
  readonly params: Record<string, string | string[]>
  readonly unroutableParams: Record<string, string | string[]>
  readonly pathname: string
}

const SWITCHES: readonly SwitchCase[] = [
  {
    name: 'host list',
    Route: HostListRoute,
    params: { hostId: 'host-1' },
    unroutableParams: { hostId: '' },
    pathname: '/h/host-1'
  },
  {
    name: 'tasks',
    Route: TasksRoute,
    params: { hostId: 'host-1' },
    unroutableParams: { hostId: '' },
    pathname: '/h/host-1/tasks'
  },
  {
    name: 'accounts',
    Route: AccountsRoute,
    params: { hostId: 'host-1' },
    unroutableParams: { hostId: '' },
    pathname: '/h/host-1/accounts'
  },
  {
    name: 'agent history',
    Route: AgentHistoryRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    unroutableParams: { hostId: 'host-1', worktreeId: '' },
    pathname: '/h/host-1/agent-history/wt-1'
  },
  {
    name: 'files',
    Route: FilesRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    unroutableParams: { hostId: 'host-1', worktreeId: '..' },
    pathname: '/h/host-1/files/wt-1'
  },
  {
    name: 'file preview',
    Route: FilesPreviewRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1', relativePath: 'src/index.ts' },
    unroutableParams: { hostId: 'host-1', worktreeId: 'wt-1' },
    pathname: '/h/host-1/files/preview/wt-1'
  },
  {
    name: 'source control',
    Route: SourceControlRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    unroutableParams: { hostId: 'host-1', worktreeId: '' },
    pathname: '/h/host-1/source-control/wt-1'
  },
  {
    name: 'review',
    Route: ReviewRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    unroutableParams: { hostId: 'host-1', worktreeId: '' },
    pathname: '/h/host-1/review/wt-1'
  },
  {
    name: 'session',
    Route: SessionRoute,
    params: { hostId: 'host-1', worktreeId: 'wt-1' },
    unroutableParams: { hostId: 'host-1', worktreeId: '' },
    pathname: '/h/host-1/session/wt-1'
  },
  {
    name: 'catch-all',
    Route: CatchAllRoute,
    params: { hostId: 'host-1', page: ['settings'] },
    unroutableParams: { hostId: 'host-1' },
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
    dependencies.refusals = 0
    dependencies.shells.length = 0
  })

  it('commits the shell on its first frame', async () => {
    dependencies.params = { ...entry.params }
    renderFirstFrame(entry.Route)
    expect(dependencies.shells).toEqual([entry.pathname])
    await act(async () => {})
    expect(dependencies.refusals).toBe(0)
    expect(dependencies.shells).toEqual([entry.pathname])
  })

  it('commits the refusal for params that name no screen the shell could open', async () => {
    dependencies.params = { ...entry.unroutableParams }
    renderFirstFrame(entry.Route)
    await act(async () => {})
    expect(dependencies.refusals).toBe(1)
    expect(dependencies.shells).toEqual([])
  })
})
