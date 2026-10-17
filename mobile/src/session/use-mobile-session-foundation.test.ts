import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileSessionFoundation } from './use-mobile-session-foundation'

type RouteParams = Record<string, string | string[] | undefined>

const doubles = vi.hoisted(() => ({
  params: {},
  hostClient: vi.fn(),
  liveName: vi.fn(),
  prContext: vi.fn()
}))

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => doubles.params
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 1, right: 2, bottom: 3, left: 4 })
}))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ replace: vi.fn() })
}))
vi.mock('../transport/client-context', () => ({
  useHostClient: (hostId: string | undefined) => doubles.hostClient(hostId),
  useForceReconnect: () => vi.fn()
}))
vi.mock('../transport/client-context-connection-metrics', () => ({
  useReconnectAttempt: () => 0,
  useLastConnectedAt: () => null
}))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isWideLayout: false })
}))
vi.mock('./use-live-worktree-name', () => ({
  useLiveWorktreeName: (args: unknown) => doubles.liveName(args)
}))
vi.mock('./use-missing-worktree-bounce', () => ({
  useMissingWorktreeBounce: vi.fn()
}))
vi.mock('./use-mobile-pr-branch-context', () => ({
  useMobilePrBranchContext: (args: unknown) => doubles.prContext(args)
}))
vi.mock('../components/host-protocol-gates-context', () => ({
  useHostProtocolGates: () => ({ hostCapabilities: null })
}))

describe('useMobileSessionFoundation route params', () => {
  let renderer: ReactTestRenderer | null = null
  let model: ReturnType<typeof useMobileSessionFoundation> | null = null

  beforeEach(() => {
    doubles.params = {}
    doubles.hostClient.mockReset().mockReturnValue({
      client: null,
      clientId: null,
      state: 'disconnected'
    })
    doubles.liveName.mockReset().mockReturnValue({ name: '', resolution: 'unknown' })
    doubles.prContext.mockReset().mockReturnValue({
      isGithubRepo: false,
      repoLoaded: true
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    model = null
  })

  function mount(params: RouteParams): void {
    doubles.params = params
    function Harness(): null {
      model = useMobileSessionFoundation()
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
  }

  it('keeps valid scalar route params unchanged', () => {
    mount({
      hostId: 'host-1',
      worktreeId: 'repo::/worktree',
      name: 'Workspace',
      created: '1',
      warning: 'created'
    })

    expect(model?.hostId).toBe('host-1')
    expect(model?.worktreeId).toBe('repo::/worktree')
    expect(model?.routeWorktreeName).toBe('Workspace')
    expect(model?.created).toBe('1')
    expect(model?.createdWarning).toBe('created')
    expect(doubles.hostClient).toHaveBeenCalledWith('host-1')
    expect(doubles.liveName).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'repo::/worktree', routeName: 'Workspace' })
    )
  })

  it('takes the first value when expo-router returns repeated route params', () => {
    mount({
      hostId: ['host-1', 'host-2'],
      worktreeId: ['folder:/workspace', 'repo::/other'],
      name: ['Workspace', 'Other'],
      created: ['1', '0'],
      warning: ['first warning', 'second warning']
    })

    expect(model?.hostId).toBe('host-1')
    expect(model?.worktreeId).toBe('folder:/workspace')
    expect(model?.routeWorktreeName).toBe('Workspace')
    expect(model?.created).toBe('1')
    expect(model?.createdWarning).toBe('first warning')
    expect(doubles.hostClient).toHaveBeenCalledWith('host-1')
    expect(doubles.prContext).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'folder:/workspace' })
    )
  })

  it('parks client-dependent hooks when the route identity is missing', () => {
    mount({ name: ['orphan', 'other'] })

    expect(model?.hostId).toBe('')
    expect(model?.worktreeId).toBe('')
    expect(doubles.hostClient).toHaveBeenCalledWith(undefined)
    expect(doubles.liveName).toHaveBeenCalledWith(
      expect.objectContaining({ client: null, worktreeId: '' })
    )
    expect(doubles.prContext).toHaveBeenCalledWith(
      expect.objectContaining({ client: null, worktreeId: '' })
    )
  })
})
