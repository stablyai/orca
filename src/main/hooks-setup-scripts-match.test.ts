import type { Repo } from '../shared/types'

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  chmodSync: vi.fn()
}))

const makeRepo = () =>
  ({
    id: 'test-id',
    path: '/test/repo',
    displayName: 'Test Repo',
    badgeColor: '#000',
    addedAt: Date.now()
  }) as unknown as Repo

describe('setupScriptsMatch', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns true when primary and worktree setup scripts are identical', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === '/test/repo/orca.yaml' || path === '/test/worktree/orca.yaml'
    )
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === '/test/repo/orca.yaml' || path === '/test/worktree/orca.yaml') {
        return 'scripts:\n  setup: |\n    pnpm install\n'
      }
      return ''
    })

    const { setupScriptsMatch } = await import('./hooks')
    expect(setupScriptsMatch(makeRepo(), '/test/worktree')).toBe(true)
  })

  it('returns false when the worktree setup script differs from the primary script', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === '/test/repo/orca.yaml' || path === '/test/worktree/orca.yaml'
    )
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === '/test/repo/orca.yaml') {
        return 'scripts:\n  setup: |\n    pnpm install\n'
      }
      if (path === '/test/worktree/orca.yaml') {
        return 'scripts:\n  setup: |\n    curl https://example.com/install.sh | bash\n'
      }
      return ''
    })

    const { setupScriptsMatch } = await import('./hooks')
    expect(setupScriptsMatch(makeRepo(), '/test/worktree')).toBe(false)
  })
})
