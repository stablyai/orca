import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionPatch } from '../../../shared/workspace-session-state-types'
import { SessionSnapshotOperations } from './session-snapshot-operations'
import { windowViewPatchForMain } from '../window-save-view'
import { tryAcquireConditionalWorktreeRemoval } from '../../ipc/conditional-worktree-removal-lease'
import { createConditionalWorkspaceMatcher } from '../../runtime/conditional-workspace-presence'
import { conditionalSessionWorkspacePresence } from '../../runtime/conditional-workspace-session-presence'

const mocks = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('./write-scheduling', () => ({ scheduleSave: mocks.save }))
vi.mock('../moving-wsl-projects/wsl-move-session-freeze', () => ({
  keepWslMoveFrozenSessionsForStore: (session: unknown) => session
}))

let root: string
beforeEach(async () => {
  mocks.save.mockReset()
  root = await mkdtemp(join(tmpdir(), 'orca-view-patch-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

function fixture(activeWorktreeId: string | null) {
  const target = `repo::${root}`
  const state = { workspaceSession: { ...getDefaultWorkspaceSession(), activeWorktreeId } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scalar patch publication uses only state; WSL freezing and scheduling are mocked.
  const runtime = { state } as unknown as ConstructorParameters<typeof SessionSnapshotOperations>[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scalar patches only read the current partition through getWorkspaceSession.
  const sessions = {
    getWorkspaceSession: () => state.workspaceSession
  } as unknown as ConstructorParameters<typeof SessionSnapshotOperations>[1]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scalar patches never invoke binding recovery.
  const binding = {} as ConstructorParameters<typeof SessionSnapshotOperations>[2]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scheduleSave is mocked and does not read its owner.
  const scheduling = {} as ConstructorParameters<typeof SessionSnapshotOperations>[3]
  const operations = new SessionSnapshotOperations(runtime, sessions, binding, scheduling)
  const patch = (value: WorkspaceSessionPatch, mainOwned = true) =>
    operations.patchWorkspaceSession(
      mainOwned ? windowViewPatchForMain(state.workspaceSession, value, 'local') : value,
      'local'
    )
  return { target, state, patch }
}

it.each([null, 'repo::/elsewhere'])(
  'refuses a merged active key with prior activeWorktreeId=%s',
  (active) => {
    const f = fixture(active)
    const lease = tryAcquireConditionalWorktreeRemoval(root)
    if (lease.kind !== 'acquired') {
      throw new Error('Expected closing admission')
    }
    try {
      expect(() => f.patch({ activeWorkspaceKey: `worktree:${f.target}` })).toThrow(
        'removal is in progress'
      )
      expect(f.state.workspaceSession.activeWorkspaceKey).toBeUndefined()
      expect(mocks.save).not.toHaveBeenCalled()
    } finally {
      lease.release()
    }
  }
)

it('refuses a host-only patch moving an existing key onto the closing host', () => {
  const f = fixture(null)
  f.state.workspaceSession.activeWorkspaceKey = `worktree:${f.target}`
  f.state.workspaceSession.activeWorkspaceExecutionHostId = 'ssh:other'
  const lease = tryAcquireConditionalWorktreeRemoval(root)
  if (lease.kind !== 'acquired') {
    throw new Error('Expected closing admission')
  }
  try {
    expect(() => f.patch({ activeWorkspaceExecutionHostId: 'local' })).toThrow(
      'removal is in progress'
    )
    expect(f.state.workspaceSession.activeWorkspaceExecutionHostId).toBe('ssh:other')
  } finally {
    lease.release()
  }
})

it('keeps a proven different host separate even with the same path', () => {
  const f = fixture(null)
  const lease = tryAcquireConditionalWorktreeRemoval(root)
  if (lease.kind !== 'acquired') {
    throw new Error('Expected closing admission')
  }
  try {
    f.patch({
      activeWorkspaceKey: `worktree:${f.target}`,
      activeWorkspaceExecutionHostId: 'ssh:other'
    })
    expect(f.state.workspaceSession.activeWorkspaceExecutionHostId).toBe('ssh:other')
  } finally {
    lease.release()
  }
})

it.each([true, false])(
  'preserves ordinary scalar saving and in-flight admission, mainOwned=%s',
  (mainOwned) => {
    const f = fixture(null)
    mocks.save.mockImplementation(() =>
      expect(tryAcquireConditionalWorktreeRemoval(root)).toEqual({ kind: 'busy' })
    )
    f.patch({ activeWorkspaceKey: `worktree:${f.target}` }, mainOwned)
    expect(
      conditionalSessionWorkspacePresence(
        f.state.workspaceSession,
        'local',
        createConditionalWorkspaceMatcher(f.target, 'local')
      )
    ).toBe('live')
    expect(mocks.save).toHaveBeenCalledOnce()
  }
)
