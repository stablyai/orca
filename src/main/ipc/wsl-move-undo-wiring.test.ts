import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { wslMoveCutoverFixture } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { wslMoverProfile } from '../persistence/__fixtures__/wsl-mover/wsl-mover-profiles'
import { createWslMoveUndoPorts } from './wsl-move-undo-wiring'

const rpc = vi.hoisted(() => ({
  call: vi.fn(async (..._args: unknown[]): Promise<unknown> => null)
}))
vi.mock('./runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: (...args: unknown[]) => rpc.call(...args)
}))
const host = vi.hoisted(() => ({
  disabled: new Array<string[]>(),
  enabledOnHost: new Map<string, boolean>(),
  listed: true,
  unreadable: false,
  removalPending: false
}))
vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: () => {
    if (host.unreadable) {
      throw new Error('environment store unreadable')
    }
    return host.listed ? [{ id: 'wsl:Ubuntu' }] : []
  }
}))
vi.mock('./wsl-move-host-connect', () => ({
  wslHostRemovalPending: () => host.removalPending
}))
vi.mock('./wsl-host-automation-disable', () => ({
  readWslHostAutomationStates: async (_userData: string, _environmentId: string, ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, host.enabledOnHost.get(id) ?? false])),
  disableWslHostAutomations: async (_userData: string, _environmentId: string, ids: string[]) => {
    host.disabled.push([...ids])
    return [...ids]
  },
  restoreWslHostAutomations: async () => {}
}))

const MOVED = wslMoverProfile('mixed-windows-wsl', 'source').session.activeWorktreeId ?? ''
const MOVED_ON_HOST = 'repo-a::/home/dev/app'

// verify-15b 6c: after undo the window reopened the host copy it was focused on, and the host
// resumed the pane's agent there beside the one restored here.
describe("undo's return of focus", () => {
  it('points the local session back at the project here before the window reloads', () => {
    const move = wslMoveCutoverFixture(
      'move-1',
      'retained',
      {},
      { repoIds: ['repo-a'], folderWorkspaceIds: [] }
    )
    let session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [MOVED]: [] },
      activeWorktreeId: MOVED_ON_HOST,
      activeWorkspaceKey: `worktree:${MOVED_ON_HOST}`,
      activeWorkspaceExecutionHostId: toRuntimeExecutionHostId(move.destinationEnvironmentId)
    }
    const store = {
      getWorkspaceSession: () => session,
      listAutomations: () => [],
      updateAutomation: vi.fn(),
      patchWorkspaceSession: vi.fn((patch: Partial<WorkspaceSessionState>, hostId?: string) => {
        expect(hostId).toBe(LOCAL_EXECUTION_HOST_ID)
        session = { ...session, ...patch }
      })
    }
    createWslMoveUndoPorts(store, '/user-data').refocusHere?.(move)
    expect(session).toMatchObject({
      activeWorkspaceExecutionHostId: LOCAL_EXECUTION_HOST_ID,
      activeWorktreeId: MOVED,
      activeWorkspaceKey: `worktree:${MOVED}`
    })
    // A second call finds focus already here and writes nothing.
    store.patchWorkspaceSession.mockClear()
    createWslMoveUndoPorts(store, '/user-data').refocusHere?.(move)
    expect(store.patchWorkspaceSession).not.toHaveBeenCalled()
  })
})

describe("undo's host automation port", () => {
  const move = wslMoveCutoverFixture(
    'move-1',
    'retained',
    {},
    { repoIds: ['repo-a'] },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the port reads only the moved automations' ids.
    { automations: [{ id: 'off-on-host' }, { id: 'on-on-host' }, { id: 'same' }] } as never
  )
  const localRows = () => [
    // d3a case 1: turned off on the host after the move, still on here.
    { id: 'off-on-host', enabled: true },
    // d3a case 2: off here before the move, turned on on the host after.
    { id: 'on-on-host', enabled: false },
    { id: 'same', enabled: true },
    { id: 'not-moved', enabled: true }
  ]
  const storeWith = () => {
    const updateAutomation = vi.fn()
    return {
      store: {
        getWorkspaceSession: () => getDefaultWorkspaceSession(),
        patchWorkspaceSession: vi.fn(),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the port reads only `id` and `enabled`.
        listAutomations: () => localRows() as never,
        updateAutomation
      },
      updateAutomation
    }
  }

  it("turns off every host copy of the move's automations, then carries the host's states here", async () => {
    host.disabled = []
    host.listed = true
    host.enabledOnHost = new Map([
      ['off-on-host', false],
      ['on-on-host', true],
      ['same', true]
    ])
    const { store, updateAutomation } = storeWith()
    const stopped = await createWslMoveUndoPorts(store, '/user-data').stopHostAutomations?.(move)
    // Every moved automation is read on the host; those on there are turned off.
    expect(host.disabled).toEqual([['on-on-host', 'same']])
    if (stopped?.outcome !== 'stopped') {
      throw new Error('expected stopped')
    }
    // Nothing changes here until the release applies it.
    expect(updateAutomation).not.toHaveBeenCalled()
    stopped.applyHere()
    expect(updateAutomation.mock.calls).toEqual([
      ['off-on-host', { enabled: false }],
      ['on-on-host', { enabled: true }]
    ])
  })

  it('asks a removed host nothing', async () => {
    host.disabled = []
    host.listed = false
    const { store } = storeWith()
    expect(
      (await createWslMoveUndoPorts(store, '/user-data').stopHostAutomations?.(move))?.outcome
    ).toBe('stopped')
    expect(host.disabled).toEqual([])
  })
})

describe("undo's host automation port, refusing", () => {
  const move = wslMoveCutoverFixture('move-1', 'retained', {}, { repoIds: ['repo-a'] })
  const store = {
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    patchWorkspaceSession: vi.fn(),
    listAutomations: () => [],
    updateAutomation: vi.fn()
  }

  it('fails, without throwing past the spawn fence, when the environment store is unreadable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    host.unreadable = true
    try {
      expect(await createWslMoveUndoPorts(store, '/user-data').stopHostAutomations?.(move)).toEqual(
        { outcome: 'failed' }
      )
    } finally {
      host.unreadable = false
    }
  })

  it('names a host whose Remove is pending (E11) rather than calling it unreachable', async () => {
    host.listed = true
    host.removalPending = true
    try {
      expect(await createWslMoveUndoPorts(store, '/user-data').stopHostAutomations?.(move)).toEqual(
        { outcome: 'removal-pending' }
      )
    } finally {
      host.removalPending = false
    }
  })
})

// verify-15c: with the host's orcad stopped, undo of a moved project this computer kept no tabs
// for asked the host nothing, released it, and its host shell kept running.
describe("undo's stop of the host's terminals", () => {
  const move = wslMoveCutoverFixture('move-1', 'retained', {}, { repoIds: ['repo-a'] })
  // A moved project keeps only its chats here, so this one names no workspace at all.
  const store = {
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    patchWorkspaceSession: vi.fn(),
    listAutomations: () => [],
    updateAutomation: vi.fn()
  }

  it('refuses when the host does not answer, though this computer names none of its workspaces', async () => {
    host.listed = true
    rpc.call.mockReset()
    rpc.call.mockRejectedValue(new Error('timed out'))
    expect(await createWslMoveUndoPorts(store, '/user-data').stopHostCopies(move)).toBe(
      'unreachable'
    )
    expect(rpc.call.mock.calls.map(([, , method]) => method)).toEqual(['terminal.list'])
  })

  it("sleeps the host's workspaces of the move that run a terminal, and only those", async () => {
    host.listed = true
    const live = new Set(['repo-a::/home/dev/repo-a'])
    rpc.call.mockReset()
    rpc.call.mockImplementation(async (...args: unknown[]) => {
      const [, , method, params] = args
      const worktree =
        typeof params === 'object' && params !== null && 'worktree' in params
          ? String(params.worktree).slice('id:'.length)
          : null
      if (method === 'worktree.sleep' && worktree) {
        live.delete(worktree)
        return { ok: true, result: {} }
      }
      const terminals = [
        { worktreeId: 'repo-a::/home/dev/repo-a', connected: live.has('repo-a::/home/dev/repo-a') },
        { worktreeId: 'repo-other::/home/dev/other', connected: true }
      ].filter((terminal) => worktree === null || terminal.worktreeId === worktree)
      return { ok: true, result: { terminals, truncated: false } }
    })
    expect(await createWslMoveUndoPorts(store, '/user-data').stopHostCopies(move)).toBe('stopped')
    const slept = rpc.call.mock.calls
      .filter(([, , method]) => method === 'worktree.sleep')
      .map(([, , , params]) => params)
    expect(slept).toEqual([{ worktree: 'id:repo-a::/home/dev/repo-a' }])
  })

  describe("the host's answer for one workspace", () => {
    const answering = (workspaceAnswer: unknown) => {
      rpc.call.mockReset()
      rpc.call.mockImplementation(async (...args: unknown[]) => {
        const [, , method, params] = args
        if (
          method === 'terminal.list' &&
          typeof params === 'object' &&
          params &&
          'worktree' in params
        ) {
          return workspaceAnswer
        }
        if (method === 'worktree.sleep') {
          return { ok: true, result: {} }
        }
        return {
          ok: true,
          result: {
            terminals: [{ worktreeId: 'repo-a::/home/dev/repo-a', connected: true }],
            truncated: false
          }
        }
      })
    }

    it('reads a workspace the host no longer has as running nothing', async () => {
      host.listed = true
      answering({ ok: false, error: { code: 'selector_not_found', message: 'gone' } })
      expect(await createWslMoveUndoPorts(store, '/user-data').stopHostCopies(move)).toBe('stopped')
    })

    it('reads any other error, or an answer it cannot read, as the host not answering', async () => {
      host.listed = true
      for (const answer of [
        { ok: false, error: { code: 'runtime_unavailable', message: 'busy' } },
        { ok: true, result: { nothing: 'useful' } }
      ]) {
        answering(answer)
        expect(await createWslMoveUndoPorts(store, '/user-data').stopHostCopies(move)).toBe(
          'unreachable'
        )
      }
    })
  })
})
