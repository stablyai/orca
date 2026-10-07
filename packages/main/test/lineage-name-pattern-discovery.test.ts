import { describe, it, expect } from 'vitest'
import type { GitWorktreeInfo } from '../../../src/shared/worktree/types'
import { matchesTicketKeys } from '../../../src/shared/lineage-ticket-keys'
import { DEFAULT_KEY_REGEX } from '../../../src/shared/lineage-discovery-types'
import { extractKeysWithPattern } from '../../../src/main/lineage/lineage-key-extraction'
import { discoverPatternTargets } from '../../../src/main/lineage/lineage-name-pattern-discovery'

function wt(path: string, branch: string, isMainWorktree = false): GitWorktreeInfo {
  return { path, head: 'abc', branch, isBare: false, isMainWorktree }
}

// why: the renderer-side default-pattern extractor was removed; main's bounded extractor is the only one
describe('default key extraction', () => {
  const keysOf = (text: string): string[] => extractKeysWithPattern(text, DEFAULT_KEY_REGEX).keys

  it('pulls ticket keys out of branch-like and workspace-like names', () => {
    expect(keysOf('levgp-483-new-loan-desacoplar')).toEqual(['LEVGP-483'])
    expect(keysOf('feat/LEVGP-483-nova-oferta')).toEqual(['LEVGP-483'])
    expect(keysOf('feat/levgp-483-x levgp-483-new-loan')).toEqual(['LEVGP-483'])
  })

  it('returns unique keys and ignores text without a key', () => {
    expect(keysOf('LEVGP-483 e levgp-483 e ABC-12')).toEqual(['LEVGP-483', 'ABC-12'])
    expect(keysOf('main')).toEqual([])
  })
})

describe('matchesTicketKeys', () => {
  it('matches case-insensitively on token boundaries', () => {
    expect(matchesTicketKeys('refs/heads/feature/levgp-483-new-loan', ['LEVGP-483'])).toBe(true)
    expect(matchesTicketKeys('fix/LEVGP-483', ['LEVGP-483'])).toBe(true)
  })

  it('does not match a longer ticket number or a different key', () => {
    expect(matchesTicketKeys('feature/levgp-4831-other', ['LEVGP-483'])).toBe(false)
    expect(matchesTicketKeys('feature/xlevgp-483', ['LEVGP-483'])).toBe(false)
    expect(matchesTicketKeys('main', ['LEVGP-483'])).toBe(false)
  })
})

describe('discoverPatternTargets', () => {
  const repos = [
    { id: 'r1', path: '/p/loans.loan-core', displayName: 'loan-core' },
    { id: 'r2', path: '/p/loans.loan-bff', displayName: 'loan-bff' },
    { id: 'r3', path: '/p/remote', displayName: 'remote', connectionId: 'ssh-1' }
  ]
  const listWorktreesFn = async (repoPath: string): Promise<GitWorktreeInfo[]> => {
    if (repoPath === '/p/loans.loan-core') {
      return [
        wt('/p/loans.loan-core', 'refs/heads/feature/levgp-483-new-loan', true),
        wt('/o/loan-core/other', 'refs/heads/chore/unrelated')
      ]
    }
    return [wt('/p/loans.loan-bff', 'refs/heads/main', true)]
  }

  it('finds primary checkouts and linked worktrees whose branch carries the ticket key', async () => {
    const targets = await discoverPatternTargets({
      repos,
      keys: ['LEVGP-483'],
      listWorktreesFn
    })
    expect(targets).toEqual([
      {
        repoId: 'r1',
        repoName: 'loan-core',
        worktreePath: '/p/loans.loan-core',
        branch: 'feature/levgp-483-new-loan',
        matchedOn: 'branch',
        matchedKey: 'LEVGP-483'
      }
    ])
  })

  it('skips remote repos and excluded paths', async () => {
    const targets = await discoverPatternTargets({
      repos,
      keys: ['LEVGP-483'],
      excludePaths: ['/p/loans.loan-core'],
      listWorktreesFn
    })
    expect(targets).toEqual([])
  })

  it('returns nothing when there are no keys', async () => {
    expect(await discoverPatternTargets({ repos, keys: [], listWorktreesFn })).toEqual([])
  })

  it('matches the worktree directory name and respects repoScope', async () => {
    const named = async (): Promise<GitWorktreeInfo[]> => [
      wt('/p/levgp-483-dir', 'refs/heads/main')
    ]
    const local = [
      { id: 'a', path: '/a', displayName: 'a' },
      { id: 'b', path: '/b', displayName: 'b' }
    ]
    const byName = await discoverPatternTargets({
      repos: local,
      keys: ['LEVGP-483'],
      matchOn: 'worktree-name',
      repoScope: ['b'],
      listWorktreesFn: named
    })
    expect(byName).toHaveLength(1)
    expect(byName[0]).toMatchObject({ repoName: 'b', matchedOn: 'worktree-name' })
    const branchOnly = await discoverPatternTargets({
      repos: local,
      keys: ['LEVGP-483'],
      listWorktreesFn: named
    })
    expect(branchOnly).toEqual([])
  })
})
