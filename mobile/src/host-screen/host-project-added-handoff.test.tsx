import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const doubles = vi.hoisted(() => {
  const activateRequests: unknown[] = []
  const pushes: string[] = []
  return { activateRequests, pushes }
})

vi.mock('./host-screen-operations', () => ({
  worktreeActivate: {
    request: (_client: unknown, params: unknown) => {
      doubles.activateRequests.push(params)
      return Promise.resolve({})
    }
  },
  worktreePinWrite: { request: () => Promise.resolve({}) },
  worktreeRemove: { request: () => Promise.resolve({}) }
}))
vi.mock('../transport/host-removal-lifecycle', () => ({
  removeHostAndCloseClient: () => Promise.resolve()
}))
vi.mock('../host-route-exit', () => ({ leaveHostRoute: vi.fn() }))
vi.mock('../storage/preferences', () => ({ savePinnedIds: async () => {} }))

import type { RpcClient } from '../transport/rpc-client'
import { useHostWorktreeActions } from './use-host-worktree-actions'
import type { HostScreenState } from './use-host-screen-state'
import type { Worktree } from '../worktree/workspace-list-sections'

type HandoffWorktreeFields = {
  worktreeId: string
  repoId: string
  repo: string
  displayName: string
  isMainWorktree?: boolean
}

function worktreeRow(fields: HandoffWorktreeFields): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handoff path reads repoId/isMainWorktree/worktreeId/displayName/repo only; the rest of Worktree is unreachable from it.
  return fields as unknown as Worktree
}

const addedRepo = { id: 'repo-added', path: '/srv/fresh-clone', displayName: 'fresh-clone' }

function handoffWith(confirmed: Worktree[] | undefined): (repo: typeof addedRepo) => Promise<void> {
  const router = {
    // The handoff's landing is this push: the default checkout's session route.
    push: (target: string) => doubles.pushes.push(target),
    replace: vi.fn()
  }
  const held: { handoff: ((repo: typeof addedRepo) => Promise<void>) | null } = { handoff: null }
  function Probe(): null {
    const actions = useHostWorktreeActions({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktreeActivate is mocked above, so the client never leaves the hook's null-check.
      client: {} as unknown as RpcClient,
      connState: 'connected',
      embedded: false,
      fetchWorktrees: () => Promise.resolve(confirmed),
      forgetHostClient: () => {},
      hostCapabilities: [],
      hostId: 'host-a',
      pathname: '/h/host-a',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: navigateFromHostList (embedded: false) reads push only; every other router member is unreachable from the handoff.
      router: router as unknown as Parameters<typeof useHostWorktreeActions>[0]['router'],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handoff path reads setOptimisticActiveWorktreeIdentity and the modal refs' null defaults; every other member is unreachable from it.
      state: {
        setOptimisticActiveWorktreeIdentity: () => {}
      } as unknown as HostScreenState
    })
    held.handoff = actions.handleProjectAdded
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
  if (held.handoff === null) {
    throw new Error('the actions hook did not mount')
  }
  return held.handoff
}

describe('the Add project handoff', () => {
  it("lands on the added repo's default checkout, never a create-workspace form", async () => {
    doubles.activateRequests.length = 0
    doubles.pushes.length = 0
    const handoff = handoffWith([
      worktreeRow({
        worktreeId: 'wt-main',
        repoId: 'repo-added',
        repo: 'fresh-clone',
        displayName: 'fresh-clone',
        isMainWorktree: true
      }),
      worktreeRow({
        worktreeId: 'wt-side',
        repoId: 'repo-added',
        repo: 'fresh-clone',
        displayName: 'fresh-clone (dudupii/side)'
      })
    ])
    await act(async () => {
      await handoff(addedRepo)
    })
    expect(doubles.activateRequests).toEqual([
      { worktree: 'id:wt-main', notifyClients: false, navigation: 'caller' }
    ])
    expect(doubles.pushes).toEqual([
      `/h/host-a/session/wt-main?name=${encodeURIComponent('fresh-clone')}`
    ])
  })

  it('stays on the refreshed list when the catalog has no main worktree for the repo', async () => {
    doubles.activateRequests.length = 0
    doubles.pushes.length = 0
    const handoff = handoffWith([
      worktreeRow({
        worktreeId: 'wt-other-repo',
        repoId: 'repo-other',
        repo: 'elsewhere',
        displayName: 'elsewhere',
        isMainWorktree: true
      })
    ])
    await act(async () => {
      await handoff(addedRepo)
    })
    expect(doubles.activateRequests).toEqual([])
    expect(doubles.pushes).toEqual([])
  })
})
