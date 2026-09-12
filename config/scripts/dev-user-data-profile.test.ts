import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs build script without type declarations
import {
  isPrimaryWorktreePath,
  resolveDevUserDataProfile,
  sanitizeProfileSegment
} from './dev-user-data-profile.mjs'

const BASE = '/home/dev/.config'
const MAIN = '/src/orca'
const WORKTREE = '/src/orca-worktrees/sandbox-a'

function resolve(overrides: Partial<Parameters<typeof resolveDevUserDataProfile>[0]> = {}): {
  path: string
  kind: string
  shouldClaim: boolean
} {
  return resolveDevUserDataProfile({
    repoRoot: MAIN,
    baseDir: BASE,
    isPrimaryWorktree: true,
    worktreeName: 'orca',
    readOwnerRepoRoot: () => null,
    env: {},
    ...overrides
  })
}

describe('resolveDevUserDataProfile', () => {
  it('keeps the legacy shared profile for an unclaimed primary worktree', () => {
    expect(resolve()).toMatchObject({ path: `${BASE}/orca-dev`, kind: 'shared' })
  })

  it('keeps the shared profile across restarts of the checkout that claimed it', () => {
    expect(resolve({ readOwnerRepoRoot: () => MAIN })).toMatchObject({ path: `${BASE}/orca-dev` })
  })

  it('gives a linked worktree its own profile even when the shared one is unclaimed', () => {
    expect(
      resolve({ repoRoot: WORKTREE, isPrimaryWorktree: false, worktreeName: 'sandbox-a' })
    ).toMatchObject({ path: `${BASE}/orca-dev-sandbox-a`, kind: 'worktree', shouldClaim: true })
  })

  it('gives a second clone its own profile once another checkout owns the shared one', () => {
    expect(
      resolve({
        repoRoot: '/src/orca-two',
        worktreeName: 'orca-two',
        readOwnerRepoRoot: (dir: string) => (dir === `${BASE}/orca-dev` ? MAIN : null)
      })
    ).toMatchObject({ path: `${BASE}/orca-dev-orca-two`, kind: 'worktree' })
  })

  it('disambiguates same-named worktrees from different repositories', () => {
    const first = resolve({
      repoRoot: '/a/sandbox',
      isPrimaryWorktree: false,
      worktreeName: 'sandbox',
      readOwnerRepoRoot: (dir: string) => (dir === `${BASE}/orca-dev-sandbox` ? '/b/sandbox' : null)
    })
    expect(first.kind).toBe('worktree-disambiguated')
    expect(first.path).toMatch(new RegExp(`^${BASE}/orca-dev-sandbox-[0-9a-f]{6}$`))
    // Why: a stable path per checkout — a rotating suffix would strand the previous run's state.
    expect(
      resolve({
        repoRoot: '/a/sandbox',
        isPrimaryWorktree: false,
        worktreeName: 'sandbox',
        readOwnerRepoRoot: (dir: string) =>
          dir === `${BASE}/orca-dev-sandbox` ? '/b/sandbox' : null
      }).path
    ).toBe(first.path)
  })

  it('honours an explicit override without claiming it', () => {
    expect(
      resolve({ env: { ORCA_DEV_USER_DATA_PATH: '/tmp/probe' }, isPrimaryWorktree: false })
    ).toMatchObject({ path: '/tmp/probe', kind: 'override', shouldClaim: false })
  })

  it('lets ORCA_DEV_SHARED_PROFILE opt a worktree back into the shared profile', () => {
    expect(
      resolve({
        env: { ORCA_DEV_SHARED_PROFILE: '1' },
        isPrimaryWorktree: false,
        repoRoot: WORKTREE,
        worktreeName: 'sandbox-a'
      })
    ).toMatchObject({ path: `${BASE}/orca-dev`, kind: 'shared-forced', shouldClaim: false })
  })
})

describe('sanitizeProfileSegment', () => {
  it('keeps a readable directory name and strips path-significant characters', () => {
    expect(sanitizeProfileSegment('feat/new thing')).toBe('feat-new-thing')
    expect(sanitizeProfileSegment('../escape')).toBe('escape')
    expect(sanitizeProfileSegment('')).toBe('worktree')
  })
})

describe('isPrimaryWorktreePath', () => {
  it('treats matching git dirs as primary, resolving git rev-parse output against the repo root', () => {
    expect(isPrimaryWorktreePath('.git', '.git', MAIN)).toBe(true)
    expect(isPrimaryWorktreePath(`${MAIN}/.git`, '.git', MAIN)).toBe(true)
  })

  it('treats a linked worktree gitdir as non-primary', () => {
    expect(
      isPrimaryWorktreePath(`${MAIN}/.git/worktrees/sandbox-a`, `${MAIN}/.git`, WORKTREE)
    ).toBe(false)
  })

  it('falls back to primary when git is unavailable', () => {
    expect(isPrimaryWorktreePath(null, null, MAIN)).toBe(true)
  })
})
