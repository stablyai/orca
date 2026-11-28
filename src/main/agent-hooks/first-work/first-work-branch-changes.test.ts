import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { readBranchChangesForNaming } from './first-work-branch-changes'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('gives the naming prompt non-ASCII file names unquoted', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'orca-first-work-names-'))
  tempRoots.push(repo)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test User')
  // Pinned so a user-level quotePath=false cannot mask a regression.
  git('config', 'core.quotePath', 'true')
  git('config', 'commit.gpgSign', 'false')
  git('commit', '-q', '--allow-empty', '-m', 'initial')
  await writeFile(path.join(repo, '文件.txt'), 'staged\n')
  git('add', '文件.txt')
  await mkdir(path.join(repo, '新目录'))
  await writeFile(path.join(repo, '新目录', '未跟踪.md'), 'untracked\n')

  const result = await readBranchChangesForNaming({
    cwd: repo,
    baseRef: undefined,
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER
  })

  expect(result).toMatchObject({
    kind: 'changes',
    changes: {
      workingStat: expect.stringContaining('文件.txt'),
      stagedStat: expect.stringContaining('文件.txt'),
      untracked: '新目录/'
    }
  })
})
