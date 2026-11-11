import { vi } from 'vitest'
import type * as GitRepoDefaultBaseRefModule from '../../git/repo-default-base-ref'

// Fabricated repo paths need deterministic async default-ref resolution.
vi.mock('../../git/repo-default-base-ref', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRepoDefaultBaseRefModule>()
  const actualGetBaseRefDefault = actual.getBaseRefDefault
  return {
    ...actual,
    // Keep fake local defaults deterministic while WSL exercises real async Git options.
    getBaseRefDefault: vi
      .fn()
      .mockImplementation((path: string, options?: { wslDistro?: string }) =>
        options?.wslDistro ? actualGetBaseRefDefault(path, options) : Promise.resolve('origin/main')
      ),
    resolveDefaultBaseRefWithLocalGit: vi
      .fn()
      .mockImplementation((options: { cwd: string; wslDistro?: string }) =>
        options.wslDistro
          ? actualGetBaseRefDefault(options.cwd, options)
          : Promise.resolve('origin/main')
      )
  }
})

vi.mock('../../git/repo-branch-conflict', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBranchConflictKind: vi.fn().mockResolvedValue(null),
  getBranchConflictKindStrict: vi.fn().mockResolvedValue(null)
}))
