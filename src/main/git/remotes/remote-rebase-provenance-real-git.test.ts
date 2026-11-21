import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitPullRebaseFromBase } from './remote-rebase'
import { continueRebase, readRebaseStopToken } from '../source-control/mutations/rebase-continue'
import { takeOrcaRebaseProvenance } from '../source-control/mutations/orca-rebase-provenance'

describe('Orca rebase provenance for hiding Pull afterwards', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  /** feature is published; main gains an edit, conflicting with feature's app.txt when asked. */
  function createPublishedFeatureBehindOrigin(conflicting: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'orca-rebase-provenance-'))
    tempPaths.push(root)
    const remotePath = join(root, 'remote.git')
    const repoPath = join(root, 'repo')
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remotePath])
    execFileSync('git', ['init', '--quiet', '-b', 'main', repoPath])
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: repoPath,
        encoding: 'utf8',
        env: { ...process.env, GIT_EDITOR: 'true' },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    const write = (file: string, text: string) => writeFileSync(join(repoPath, file), text)
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    git('remote', 'add', 'origin', remotePath)
    write('app.txt', 'base\n')
    write('notes.txt', 'base\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'base')
    git('push', '--quiet', '-u', 'origin', 'main')
    git('checkout', '--quiet', '-b', 'feature')
    write('app.txt', 'feature\n')
    git('commit', '--quiet', '-am', 'feature')
    git('push', '--quiet', '-u', 'origin', 'feature')
    git('checkout', '--quiet', 'main')
    write(conflicting ? 'app.txt' : 'notes.txt', 'main\n')
    git('commit', '--quiet', '-am', 'main edit')
    git('push', '--quiet', 'origin', 'main')
    git('checkout', '--quiet', 'feature')
    return { repoPath, git, write }
  }

  it('reports the integrated upstream tip when the rebase lands in one go', async () => {
    const { repoPath, git } = createPublishedFeatureBehindOrigin(false)
    const upstreamTip = git('rev-parse', 'origin/feature').trim()

    await expect(gitPullRebaseFromBase(repoPath, 'origin/main')).resolves.toEqual({
      autostashConflict: false,
      integratedUpstreamOid: upstreamTip
    })
  })

  it('hands the proof to the Continue that finishes the same paused run', async () => {
    const { repoPath, git, write } = createPublishedFeatureBehindOrigin(true)
    const upstreamTip = git('rev-parse', 'origin/feature').trim()
    await expect(gitPullRebaseFromBase(repoPath, 'origin/main')).rejects.toThrow()
    write('app.txt', 'resolved\n')
    git('add', 'app.txt')
    const { stop } = await continueRebase(repoPath, 'inspect')

    await expect(continueRebase(repoPath, 'continue', { expected: stop })).resolves.toMatchObject({
      outcome: 'completed',
      integratedUpstreamOid: upstreamTip
    })
  })

  it('gives no proof when the upstream has a collaborator commit the branch lacks', async () => {
    const { repoPath, git, write } = createPublishedFeatureBehindOrigin(false)
    git('checkout', '--quiet', '-b', 'collaborator', 'origin/feature')
    write('collab.txt', 'collaborator\n')
    git('add', 'collab.txt')
    git('commit', '--quiet', '-m', 'collaborator')
    git('push', '--quiet', 'origin', 'collaborator:feature')
    git('checkout', '--quiet', 'feature')
    git('fetch', '--quiet', 'origin')

    const result = await gitPullRebaseFromBase(repoPath, 'origin/main')
    expect(result.integratedUpstreamOid).toBeUndefined()
  })

  it('gives no proof for a paused run this rebase did not create, even with the same endpoints', async () => {
    const { repoPath, git } = createPublishedFeatureBehindOrigin(true)
    git('fetch', '--quiet', 'origin')
    // Another tool's run, already there, with exactly the onto and orig-head Orca would write.
    const runDir = join(repoPath, '.git', 'rebase-merge')
    mkdirSync(runDir)
    writeFileSync(join(runDir, 'onto'), git('rev-parse', 'origin/main'))
    writeFileSync(join(runDir, 'orig-head'), git('rev-parse', 'HEAD'))
    writeFileSync(join(runDir, 'head-name'), 'refs/heads/feature\n')
    writeFileSync(join(runDir, 'msgnum'), '1\n')
    await expect(gitPullRebaseFromBase(repoPath, 'origin/main')).rejects.toThrow()

    const { incarnation } = await readRebaseStopToken(repoPath, {})
    expect(incarnation).not.toBeNull()
    expect(takeOrcaRebaseProvenance(repoPath, 'feature', incarnation)).toBeNull()
  })
})
