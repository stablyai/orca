import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { decodeGitCQuotedPath } from '../../src/shared/git-cquoted-path.ts'

async function git(repoRoot, args) {
  const result = await runProcess({
    program: 'git',
    args,
    cwd: repoRoot,
    timeoutMs: 30_000,
    maxOutputBytes: 4 * 1024 * 1024,
    terminationBarrier: true
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error('Could not read the local Git repository')
  }
  return result.stdout
}

export async function localRepositoryWorktrees(repoRoot) {
  const common = (await git(repoRoot, ['rev-parse', '--git-common-dir'])).replace(
    process.platform === 'win32' ? /\r?\n$/ : /\n$/,
    ''
  )
  if (!common || common.includes('\n')) {
    throw new Error('Unrecognised Git common directory')
  }
  const output = await git(repoRoot, [
    '-c',
    'core.quotePath=false',
    'worktree',
    'list',
    '--porcelain'
  ])
  const worktrees = []
  for (const block of output.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean)
    if (lines.length === 0) {
      continue
    }
    if (
      lines.some(
        (line) =>
          !/^(worktree |HEAD |branch |bare$|detached$|locked(?: |$)|prunable(?: |$))/.test(line)
      )
    ) {
      throw new Error('Ambiguous worktree listing; refusing cleanup')
    }
    const field = lines.find((line) => line.startsWith('worktree '))
    if (field && !lines.includes('bare')) {
      worktrees.push(decodeGitCQuotedPath(field.slice(9)))
    }
  }
  return { commonDirectory: await realpath(resolve(repoRoot, common)), worktrees }
}
