import { vi } from 'vitest'
import type * as GitRepoDefaultBaseRefModule from '../../git/refs/resolution/repo-default-base-ref'

// Fabricated repo paths need deterministic async default-ref resolution.
vi.mock('../../git/refs/resolution/repo-default-base-ref', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRepoDefaultBaseRefModule>()
  const actualGetDefaultBaseRefAsync = actual.getDefaultBaseRefAsync
  return {
    ...actual,
    getDefaultBaseRefAsync: vi
      .fn()
      .mockImplementation((path: string, options?: { wslDistro?: string }) =>
        options?.wslDistro
          ? actualGetDefaultBaseRefAsync(path, options)
          : Promise.resolve('origin/main')
      ),
    resolveDefaultBaseRefWithLocalGit: vi
      .fn()
      .mockImplementation((options: { cwd: string; wslDistro?: string }) =>
        options.wslDistro
          ? actualGetDefaultBaseRefAsync(options.cwd, options)
          : Promise.resolve('origin/main')
      )
  }
})

vi.mock('../../git/refs/resolution/repo-branch-conflict', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBranchConflictKind: vi.fn().mockResolvedValue(null),
  getBranchConflictKindStrict: vi.fn().mockResolvedValue(null)
}))
