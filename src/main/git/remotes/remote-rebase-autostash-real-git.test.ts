import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitPullRebaseFromBase } from './remote-rebase'

describe('gitPullRebaseFromBase with rebase.autoStash', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  function createDirtyFeatureBehindOrigin(dirtyFile: string, dirtyText: string) {
    const root = mkdtempSync(join(tmpdir(), 'orca-rebase-autostash-'))
    tempPaths.push(root)
    const remotePath = join(root, 'remote.git')
    const repoPath = join(root, 'repo')
    execFileSync('git', ['init', '--quiet', '--bare', remotePath])
    execFileSync('git', ['init', '--quiet', '-b', 'main', repoPath])
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    const write = (file: string, text: string) => writeFileSync(join(repoPath, file), text)
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    git('config', 'rebase.autoStash', 'true')
    git('remote', 'add', 'origin', remotePath)
    write('a.txt', 'base\n')
    write('c.txt', 'base\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'base')
    git('push', '--quiet', '-u', 'origin', 'main')
    git('checkout', '--quiet', '-b', 'feature')
    write('a.txt', 'feature a\n')
    git('commit', '--quiet', '-am', 'feature a')
    git('checkout', '--quiet', 'main')
    write('c.txt', 'main c\n')
    git('commit', '--quiet', '-am', 'main c')
    git('push', '--quiet', 'origin', 'main')
    git('checkout', '--quiet', 'feature')
    write(dirtyFile, dirtyText)
    return { repoPath, git }
  }

  it('reports an autostash that did not reapply even though the rebase landed', async () => {
    const { repoPath, git } = createDirtyFeatureBehindOrigin('c.txt', 'uncommitted c\n')

    await expect(gitPullRebaseFromBase(repoPath, 'origin/main')).resolves.toEqual({
      autostashConflict: true
    })
    expect(git('log', '-1', '--format=%s').trim()).toBe('feature a')
    expect(git('stash', 'list')).toContain('autostash')
  })

  it('reports a clean reapply as no autostash conflict', async () => {
    const { repoPath, git } = createDirtyFeatureBehindOrigin('a.txt', 'feature a\nplus local\n')

    await expect(gitPullRebaseFromBase(repoPath, 'origin/main')).resolves.toEqual({
      autostashConflict: false
    })
    expect(git('stash', 'list')).toBe('')
  })
})
