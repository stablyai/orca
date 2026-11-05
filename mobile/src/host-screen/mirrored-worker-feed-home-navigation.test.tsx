import { createElement } from 'react'
import { act, create as createRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import type { Worktree } from '../worktree/workspace-list-types'
import { useHostScreenState } from './use-host-screen-state'
import { useHostWorktreeActions } from './use-host-worktree-actions'
import { stubRpcClient } from '../transport/rpc-client-test-stub'

const renderers = new Set<ReturnType<typeof createRenderer>>()

vi.mock('expo-router', () => ({}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('../storage/preferences', () => ({ savePinnedIds: async () => {} }))
vi.mock('../transport/host-removal-lifecycle', () => ({ removeHostAndCloseClient: async () => {} }))
vi.mock('../host-route-exit', () => ({ leaveHostRoute: vi.fn() }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test fixture
const item = {
  worktreeId: 'folder-one',
  workspaceKind: 'folder-workspace',
  repoId: 'repo',
  repo: 'app',
  branch: '',
  displayName: 'Folder',
  path: '/workspace',
  liveTerminalCount: 1,
  hasAttachedPty: true,
  unread: false,
  isPinned: false,
  linkedPR: null
} as unknown as Worktree

afterEach(() => {
  act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.clear()
})

it('opens a mirrored worker in its feed home, not the coordinator card', async () => {
  const push = vi.fn()
  const replace = vi.fn()
  const worker = 'tab-worker:leaf'
  const coordinator = 'tab-coord:leaf'
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test fixture
  const orca = {
    ...item,
    worktreeId: 'folder:orca',
    displayName: 'Orca',
    agents: [
      { paneKey: coordinator, parentPaneKey: null },
      { paneKey: worker, parentPaneKey: coordinator }
    ]
  } as unknown as Worktree
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test fixture
  const babysitter = {
    ...item,
    worktreeId: 'folder:babysitter',
    displayName: 'Babysitter',
    hostId: 'runtime:server',
    agents: [{ paneKey: worker, parentPaneKey: coordinator }]
  } as unknown as Worktree
  const held: {
    open?: (item: Worktree, paneKey?: string) => void
    setLists?: (local: Worktree[], feed: Worktree[]) => void
  } = {}
  function Probe() {
    const state = useHostScreenState('host')
    held.setLists = (local, feed) => {
      state.setWorktrees(local)
      state.setServerWorkspaces({ hosts: [], worktrees: feed })
    }
    held.open = useHostWorktreeActions({
      client: stubRpcClient({
        sendRequest: async () => ({ id: 'activate', ok: true, result: {} })
      }),
      hostCapabilities: [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
      connState: 'connected',
      embedded: true,
      fetchWorktrees: async () => {},
      forgetHostClient: () => {},
      hostId: 'host',
      pathname: '/h/host/session/folder:orca',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial test fixture
      router: { push, replace } as unknown as Parameters<
        typeof useHostWorktreeActions
      >[0]['router'],
      state
    }).openWorktreeSession
    return null
  }
  await act(async () => {
    renderers.add(createRenderer(createElement(Probe)))
  })
  await act(async () => {
    held.setLists?.([orca], [babysitter])
  })
  await act(async () => {
    held.open?.(orca, worker)
  })
  expect(replace.mock.calls[0]?.[0]).toBe(
    `/h/host/session/${encodeURIComponent('folder:babysitter')}?name=Babysitter&executionHost=${encodeURIComponent('runtime:server')}&paneKey=${encodeURIComponent(worker)}`
  )
  expect(push).not.toHaveBeenCalled()
})
