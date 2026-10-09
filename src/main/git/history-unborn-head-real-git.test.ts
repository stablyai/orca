import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getHistory } from './history'

describe('history on an unborn HEAD (real Git)', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  /** A repo with one commit on `main`, checked out on an orphan branch that has none yet. */
  function createOrphanCheckout(): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-history-unborn-'))
    tempPaths.push(repoPath)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })
    git('init', '--quiet')
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    git('checkout', '--quiet', '-b', 'main')
    git('commit', '--quiet', '--allow-empty', '-m', 'on main')
    // checkout --orphan predates the Git 2.25 baseline; switch --orphan needs 2.23.
    git('checkout', '--quiet', '--orphan', 'orphan')
    return repoPath
  }

  it('lists the other branches for the all scope', async () => {
    const repoPath = createOrphanCheckout()

    const result = await getHistory(repoPath, { scope: 'all' })

    expect(result.scope).toBe('all')
    expect(result.items.map((item) => item.subject)).toEqual(['on main'])
    expect(result.currentRef).toBeUndefined()
  })

  it('stays empty for the current scope', async () => {
    const repoPath = createOrphanCheckout()

    const result = await getHistory(repoPath, { scope: 'current' })

    expect(result).toMatchObject({ items: [], scope: 'current', hasMore: false })
  })
})
