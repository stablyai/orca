import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectPipelineBranchCommits } from './git-commit-inspector'

describe('inspectPipelineBranchCommits', () => {
  let tempDir: string | undefined

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: tempDir, encoding: 'utf8' }).trim()
  }

  it('inspects real git commits between base and task branch', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pipeline-git-'))
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'pipeline@example.com'])
    git(['config', 'user.name', 'Pipeline Test'])
    writeFileSync(join(tempDir, 'README.md'), 'base\n')
    git(['add', 'README.md'])
    git(['commit', '-m', 'base'])
    git(['checkout', '-b', 'pipeline/issue-6'])
    writeFileSync(join(tempDir, 'README.md'), 'base\ntask\n')
    git(['commit', '-am', 'task change'])
    const commit = git(['rev-parse', 'HEAD'])

    const result = await inspectPipelineBranchCommits({
      cwd: tempDir,
      baseRef: 'main',
      branch: 'pipeline/issue-6'
    })

    expect(result.commitShas).toEqual([commit])
  })
})
