import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'

const params: Record<string, string> = {}
vi.mock('expo-router', () => ({
  useGlobalSearchParams: () => params,
  useLocalSearchParams: () => params,
  usePathname: () => '/h/desk',
  useRouter: () => routerStub
}))
const routerStub = {
  setParams: (next: Record<string, string>) => {
    Object.assign(params, next)
  }
}

const { useHostListDeleteIntent } = await import('./use-host-list-delete-intent')
const { requestHostListDelete, resetHostListDeleteIntentForTest } =
  await import('./host-list-delete-intent')

const rowA: Worktree = {
  worktreeId: 'repo::/a',
  hostId: 'local',
  repoId: 'repo',
  repo: 'repo',
  branch: 'a',
  displayName: 'a',
  path: '/a',
  liveTerminalCount: 0,
  hasAttachedPty: false,
  unread: false,
  isPinned: false,
  linkedPR: null
}
type Seen = {
  actionTarget: Worktree | null
  confirmDelete: Worktree | null
  actionError: string
  setActionError: (value: string) => void
  setShowWorkspaceOptions: (value: boolean) => void
  retire: () => boolean
}
let seen: Seen

// The list's real state shape: the claim must give way to any of the list's own actions.
function List({ rows }: { rows: readonly Worktree[] }) {
  const [actionTarget, setActionTarget] = useState<Worktree | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Worktree | null>(null)
  const [actionError, setActionError] = useState('')
  const [showWorkspaceOptions, setShowWorkspaceOptions] = useState(false)
  const retire = useHostListDeleteIntent({
    embedded: false,
    hostId: 'desk',
    connected: true,
    rows,
    bots: [],
    groupsSupported: false,
    newBotOpen: false,
    state: {
      actionTarget,
      confirmDelete,
      confirmRemoveHost: false,
      showWorkspaceOptions,
      showNewWorktree: false,
      setActionTarget,
      setConfirmDelete,
      setActionError
    }
  })
  seen = {
    actionTarget,
    confirmDelete,
    actionError,
    setActionError,
    setShowWorkspaceOptions,
    retire
  }
  return null
}

describe('useHostListDeleteIntent', () => {
  let renderer: ReactTestRenderer | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    resetHostListDeleteIntentForTest()
    params.deleteWorkspace = requestHostListDelete(
      { hostId: 'desk', owner: 'local', worktreeId: 'repo::/a' },
      Date.now()
    )
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    vi.useRealTimers()
  })
  const mount = async () => {
    await act(async () => {
      renderer = create(<List rows={[]} />)
    })
  }
  const rowsArrive = async () => act(async () => renderer?.update(<List rows={[rowA]} />))

  it('drops a held claim once Workspace Options opens, even after it closes again', async () => {
    await mount()
    await act(async () => seen.setShowWorkspaceOptions(true))
    await rowsArrive()
    await act(async () => seen.setShowWorkspaceOptions(false))
    await rowsArrive()
    expect(seen.confirmDelete).toBeNull()
    expect(seen.actionTarget).toBeNull()
  })

  it('drops a held claim on any touch on the list', async () => {
    await mount()
    act(() => void seen.retire())
    await rowsArrive()
    expect(seen.confirmDelete).toBeNull()
  })

  it("never covers another action's error when it expires", async () => {
    await mount()
    await act(async () => seen.setActionError('Could not save the view.'))
    await act(async () => {
      vi.advanceTimersByTime(11_000)
    })
    expect(seen.actionError).toBe('Could not save the view.')
  })

  it('opens the confirm for the held row when nothing else happened', async () => {
    await mount()
    await rowsArrive()
    expect(seen.confirmDelete).toEqual(rowA)
  })
})
