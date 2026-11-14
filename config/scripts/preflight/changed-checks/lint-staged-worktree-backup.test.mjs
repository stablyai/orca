import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import lintStaged from 'lint-staged'
import { expect, it } from 'vitest'

const BACKUP_REFS = 'refs/worktree/lint-staged-backups'
const silentLogger = { error() {}, log() {}, warn() {} }

it('keeps lint-staged backups isolated to the current worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-lint-staged-worktree-'))

  try {
    const repo = join(root, 'repo')
    const worktree = join(root, 'linked worktree')
    const trackedFile = join(worktree, 'tracked.txt')
    mkdirSync(repo)
    initializeRepo(repo)

    writeFileSync(join(repo, 'tracked.txt'), 'base-one\nbase-two\n')
    git(repo, ['add', 'tracked.txt'])
    git(repo, ['commit', '--quiet', '-m', 'initial'])
    writeFileSync(join(repo, 'tracked.txt'), 'user stash\nbase-two\n')
    git(repo, ['stash', 'push', '--quiet', '--message', 'user backup'])
    git(repo, ['worktree', 'add', '--quiet', '-b', 'linked', worktree])

    writeFileSync(trackedFile, 'staged-change\nbase-two\n')
    git(worktree, ['add', 'tracked.txt'])
    writeFileSync(trackedFile, 'staged-change\nunstaged-change\n')

    const expectedStash = gitTrim(worktree, ['rev-parse', 'refs/stash'])
    const stashBefore = git(worktree, ['stash', 'list', '--format=%H%x00%gs'])
    const stagedBefore = git(worktree, ['diff', '--cached', '--binary'])
    const unstagedBefore = git(worktree, ['diff', '--binary'])
    const contentBefore = readFileSync(trackedFile, 'utf8')
    const observation = join(root, 'task-observation.json')
    const probe = join(root, 'failing-task.cjs')
    writeProbe(probe)

    const task = [process.execPath, probe, expectedStash, observation].map(quote).join(' ')
    const passed = await lintStaged(
      { config: { '*.txt': task }, cwd: worktree, quiet: true },
      silentLogger
    )

    expect(passed).toBe(false)
    expect(JSON.parse(readFileSync(observation, 'utf8'))).toEqual({
      backupRefs: [expect.stringMatching(`^${BACKUP_REFS}/`)],
      sharedStash: expectedStash
    })
    expect(git(worktree, ['for-each-ref', '--format=%(refname)', BACKUP_REFS])).toBe('')
    expect(git(worktree, ['stash', 'list', '--format=%H%x00%gs'])).toBe(stashBefore)
    expect(git(worktree, ['diff', '--cached', '--binary'])).toBe(stagedBefore)
    expect(git(worktree, ['diff', '--binary'])).toBe(unstagedBefore)
    expect(readFileSync(trackedFile, 'utf8')).toBe(contentBefore)
    expect(git(worktree, ['ls-files', '--unmerged'])).toBe('')
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

function initializeRepo(repo) {
  git(repo, ['init', '--quiet'])
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'core.hooksPath', join(repo, '.git', 'no-hooks')])
  git(repo, ['config', 'commit.gpgsign', 'false'])
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function gitTrim(cwd, args) {
  return git(cwd, args).trim()
}

function quote(value) {
  return JSON.stringify(value)
}

function writeProbe(path) {
  writeFileSync(
    path,
    [
      "const { execFileSync } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim()",
      "const backupRefs = git(['for-each-ref', '--format=%(refname)', 'refs/worktree/lint-staged-backups'])",
      "writeFileSync(process.argv[3], JSON.stringify({ backupRefs: backupRefs.split('\\n').filter(Boolean), sharedStash: git(['rev-parse', 'refs/stash']) }))",
      "writeFileSync(process.argv[4], 'task-output\\n')",
      'process.exit(1)'
    ].join('\n')
  )
}
