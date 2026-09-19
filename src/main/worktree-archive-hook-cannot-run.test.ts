import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import { gateRemovalWhereArchiveHookCannotRun } from './worktree-archive-hook-gate'
import {
  ARCHIVE_HOOK_FAILED_REMOVAL_CODE,
  asArchiveHookRefusal
} from '../shared/worktree/archive-hook-removal-gate'

// Mocked at the SSH-aware reader, because that is the whole point: on an SSH worktree the hook
// lives on the execution host, not on the runtime's local disk.
const { getArchiveHooksForRemovalMock } = vi.hoisted(() => ({
  getArchiveHooksForRemovalMock: vi.fn()
}))
vi.mock('./ipc/worktrees/removal/worktree-archive-hook', () => ({
  getArchiveHooksForRemoval: getArchiveHooksForRemovalMock
}))

const REPO: Repo = { id: 'r', path: '/repo', displayName: 'r', badgeColor: '#000', addedAt: 0 }

const withArchiveHook = (present: boolean): void => {
  getArchiveHooksForRemovalMock.mockResolvedValue(
    present ? { scripts: { archive: 'archive.sh' } } : null
  )
}

const gate = (over: Partial<Parameters<typeof gateRemovalWhereArchiveHookCannotRun>[0]> = {}) =>
  gateRemovalWhereArchiveHookCannotRun({
    repo: REPO,
    connectionId: undefined,
    worktreePath: '/w/f',
    runHooks: true,
    allowFailedArchiveHook: false,
    ...over
  })

// Why (#19334 / S1): the runtime's SSH path runs no archive hook. Silently deleting there would
// reproduce the reported bug in the one place `worktree.archive-failure-blocking.v1` promises it
// cannot happen, so the capability would be advertising a guarantee it does not keep.
describe('gateRemovalWhereArchiveHookCannotRun', () => {
  it('lets a repo with no archive hook through untouched', async () => {
    withArchiveHook(false)
    await expect(gate()).resolves.toEqual({})
  })

  it('warns rather than refuses when hooks were not requested', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    withArchiveHook(true)
    await expect(gate({ runHooks: false })).resolves.toMatchObject({
      warning: expect.stringContaining('pass --run-hooks to run it')
    })
  })

  // Why (#19334): reading locally would miss the committed hook on an SSH host entirely.
  it('asks the execution host whether a hook exists, not the local disk', async () => {
    withArchiveHook(false)
    await gate({ connectionId: 'ssh-target' })
    expect(getArchiveHooksForRemovalMock).toHaveBeenCalledWith(REPO, 'ssh-target')
  })

  it('refuses a hooks-requested removal it cannot honour, as unverifiable', async () => {
    withArchiveHook(true)
    const refusal = asArchiveHookRefusal(await gate().catch((error: unknown) => error))

    expect(refusal.code).toBe(ARCHIVE_HOOK_FAILED_REMOVAL_CODE)
    // Never `exited`: nothing ran, so nothing reported an exit to read.
    expect(refusal.data).toMatchObject({ worktreePath: '/w/f', outcome: 'unverifiable' })
    expect(refusal.data.exitCode).toBeUndefined()
  })

  // Why this matters: without it the refusal is a dead loop. The desktop's "Delete Anyway" and the
  // CLI's --allow-failed-archive-hook both land here, and a block with no reachable exit on the
  // surface where it happens is the failure mode this PR fixed on the desktop path.
  it('deletes anyway when the refusal is explicitly waived, and records it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    withArchiveHook(true)

    const result = await gate({ allowFailedArchiveHook: true })

    expect(result.warning).toBeUndefined()
    expect(result.override).toMatchObject({
      worktreePath: '/w/f',
      outcome: 'unverifiable',
      overridden: true
    })
  })
})
