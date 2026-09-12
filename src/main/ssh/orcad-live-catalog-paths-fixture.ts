import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'

export type LiveCatalogSourcePaths = {
  repoPath: string
  worktreePath: string
  folderPath: string
}

export async function createLocalLiveCatalogPaths(
  directory: string
): Promise<LiveCatalogSourcePaths> {
  const repoPath = join(directory, 'repository')
  const worktreePath = join(directory, 'worktree')
  const folderPath = join(directory, 'folder')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(folderPath, { recursive: true })
  const git = async (args: string[]) => {
    const result = await runProcess({
      program: 'git',
      args: ['-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', ...args],
      cwd: repoPath,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    })
    if (result.code !== 0) {
      throw new Error(`fixture_git_failed: ${result.stderr || result.stdout}`)
    }
  }
  await git(['init'])
  await git([
    '-c',
    'user.name=Orca fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'Fixture root'
  ])
  await git(['worktree', 'add', '-b', 'fixture-worktree', worktreePath])
  return { repoPath, worktreePath, folderPath }
}
