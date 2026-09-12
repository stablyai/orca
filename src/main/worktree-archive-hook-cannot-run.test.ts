import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import { gateRemovalWhereArchiveHookCannotRun } from './worktree-archive-hook-gate'

const { getEffectiveHooksMock } = vi.hoisted(() => ({ getEffectiveHooksMock: vi.fn() }))
vi.mock('./hooks', () => ({ getEffectiveHooks: getEffectiveHooksMock }))

const REPO = { id: 'r', path: '/repo' } as Repo
const withArchiveHook = (present: boolean): void => {
  getEffectiveHooksMock.mockReturnValue(present ? { scripts: { archive: 'archive.sh' } } : null)
}
import { ARCHIVE_HOOK_FAILED_REMOVAL_CODE } from '../shared/worktree/archive-hook-removal-gate'

// Why (#19334 / S1): the runtime's SSH path runs no archive hook. Silently deleting there would
// reproduce the reported bug in the one place `worktree.archive-failure-blocking.v1` promises it
// cannot happen, so the capability would be advertising a guarantee it does not keep.
describe('gateRemovalWhereArchiveHookCannotRun', () => {
  it('lets a repo with no archive hook through untouched', () => {
    expect(
      (withArchiveHook(false),
      gateRemovalWhereArchiveHookCannotRun({ repo: REPO, worktreePath: '/w/f', runHooks: true }))
    ).toBeUndefined()
  })

  it('warns rather than refuses when hooks were not requested', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      (withArchiveHook(true),
      gateRemovalWhereArchiveHookCannotRun({ repo: REPO, worktreePath: '/w/f', runHooks: false }))
    ).toContain('pass --run-hooks to run it')
  })

  it('refuses a hooks-requested removal it cannot honour, as unverifiable', () => {
    let thrown: unknown
    try {
      withArchiveHook(true)
      gateRemovalWhereArchiveHookCannotRun({ repo: REPO, worktreePath: '/w/f', runHooks: true })
    } catch (error) {
      thrown = error
    }
    expect((thrown as { code?: string }).code).toBe(ARCHIVE_HOOK_FAILED_REMOVAL_CODE)
    // Never `exited`: nothing ran, so nothing reported an exit to read.
    expect((thrown as { data?: { outcome?: string; exitCode?: number } }).data).toMatchObject({
      worktreePath: '/w/f',
      outcome: 'unverifiable'
    })
    expect((thrown as { data?: { exitCode?: number } }).data?.exitCode).toBeUndefined()
  })
})
