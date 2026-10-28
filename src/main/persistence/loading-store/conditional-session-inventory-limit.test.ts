import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { conditionalWorkspaceSessionTargets } from '../../ipc/conditional-workspace-session-targets'
import { beginConditionalWorktreeSessionWrite } from '../../ipc/conditional-worktree-session-write'
import { tryAcquireConditionalWorktreeRemoval } from '../../ipc/conditional-worktree-removal-lease'
import { conditionalSessionWorkspacePresence } from '../../runtime/conditional-workspace-session-presence'
import {
  SessionSnapshotOperations,
  getSessionSnapshotOperationsContext
} from './session-snapshot-operations'

const mocks = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('./write-scheduling', () => ({ scheduleSave: mocks.save }))
vi.mock('../moving-wsl-projects/wsl-move-session-freeze', () => ({
  keepWslMoveFrozenSessionsForStore: (session: unknown) => session
}))
vi.mock('./workspace-session-snapshot-publication', () => ({
  setLocalWorkspaceSession: (owner: SessionSnapshotOperations, session: WorkspaceSessionState) => {
    const { runtime } = getSessionSnapshotOperationsContext(owner)
    runtime.state.workspaceSession = session
    mocks.save()
  }
}))

beforeEach(() => mocks.save.mockReset())
const removalPath = '/conditional-inventory-limit-unlisted-target'
function session(count: number): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeIdsOnShutdown: Array.from({ length: count }, (_, i) => `repo::/inventory-${i}`)
  }
}
function fixture() {
  const state = { workspaceSession: session(10001) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publication and scheduling are mocked; the real operation needs only state and admission flags.
  const runtime = { state } as unknown as ConstructorParameters<typeof SessionSnapshotOperations>[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scalar merge reads only the current local session.
  const sessions = {
    getWorkspaceSession: () => state.workspaceSession
  } as unknown as ConstructorParameters<typeof SessionSnapshotOperations>[1]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mocked snapshot publication does not perform binding recovery.
  const binding = {} as ConstructorParameters<typeof SessionSnapshotOperations>[2]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mocked scheduleSave does not inspect its owner.
  const scheduling = {} as ConstructorParameters<typeof SessionSnapshotOperations>[3]
  const operations = new SessionSnapshotOperations(runtime, sessions, binding, scheduling)
  const write = (route: 'set' | 'patch' | 'unload') => {
    if (route === 'set') {
      operations.setWorkspaceSession({ ...state.workspaceSession })
    } else if (route === 'unload') {
      operations.stageWorkspaceSessionBeforeUnload({ ...state.workspaceSession })
    } else {
      operations.patchWorkspaceSession({ activeWorkspaceExecutionHostId: 'local' })
    }
  }
  return { state, write }
}
function assertIdle() {
  const lease = tryAcquireConditionalWorktreeRemoval(removalPath)
  expect(lease.kind).toBe('acquired')
  if (lease.kind === 'acquired') {
    lease.release()
  }
}

it.each([10000, 10001])('distinguishes complete inventory at %i targets', (count) => {
  const inventory = conditionalWorkspaceSessionTargets(session(count), 'local')
  expect(inventory.complete).toBe(count === 10000)
  expect(inventory.targets).toHaveLength(count === 10000 ? count : 0)
  const match = vi.fn(() => 'different' as const)
  expect(conditionalSessionWorkspacePresence(session(count), 'local', match)).toBe(
    count === 10000 ? 'idle' : 'unknown'
  )
  expect(match).toHaveBeenCalledTimes(count === 10000 ? count : 0)
})

it.each(['set', 'patch', 'unload'] as const)(
  'saves oversized %s without closing and holds global admission during save',
  (route) => {
    const f = fixture()
    mocks.save.mockImplementation(() => {
      expect(tryAcquireConditionalWorktreeRemoval(removalPath)).toEqual({ kind: 'busy' })
    })
    f.write(route)
    expect(f.state.workspaceSession.activeWorktreeIdsOnShutdown).toHaveLength(10001)
    expect(mocks.save).toHaveBeenCalledOnce()
    assertIdle()
  }
)

it.each(['set', 'patch', 'unload'] as const)(
  'rejects oversized %s before state or save side effects during closing',
  (route) => {
    const f = fixture()
    const prior = f.state.workspaceSession
    const lease = tryAcquireConditionalWorktreeRemoval(removalPath)
    if (lease.kind !== 'acquired') {
      throw new Error('Expected closing admission')
    }
    try {
      expect(() => f.write(route)).toThrow('removal is in progress')
      expect(f.state.workspaceSession).toBe(prior)
      expect(mocks.save).not.toHaveBeenCalled()
    } finally {
      lease.release()
    }
  }
)

it.each(['set', 'patch', 'unload'] as const)(
  'releases oversized %s admission when saving throws',
  (route) => {
    const f = fixture()
    const error = new Error('save unavailable')
    mocks.save.mockImplementation(() => {
      throw error
    })
    expect(() => f.write(route)).toThrow(error)
    assertIdle()
  }
)

it('does not convert arbitrary getter failures into incomplete inventory or successful saving', () => {
  const error = new Error('invalid session accessor')
  const value = Object.defineProperty({}, 'activeWorktreeId', {
    get: () => {
      throw error
    }
  })
  expect(() => conditionalWorkspaceSessionTargets(value, 'local')).toThrow(error)
  expect(() => beginConditionalWorktreeSessionWrite(value, 'local')).toThrow(error)
  expect(conditionalSessionWorkspacePresence(value, 'local', () => 'different')).toBe('unknown')
  assertIdle()
})

it('stops after overflow without reading subsequent fields', () => {
  const later = vi.fn(() => {
    throw new Error('must not inspect later fields')
  })
  const value = Object.defineProperty(session(10001), 'tabsByWorktree', { get: later })
  expect(conditionalWorkspaceSessionTargets(value, 'local')).toEqual({
    complete: false,
    targets: []
  })
  expect(later).not.toHaveBeenCalled()
})
