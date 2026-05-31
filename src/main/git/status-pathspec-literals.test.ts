import { execFileSync } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { bulkStageFiles, bulkUnstageFiles, stageFile, unstageFile } from './status'

const tempRoots: string[] = []

async function createRepoWithGlobNamedFiles(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'orca-status-pathspec-'))
  tempRoots.push(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo })
  await writeFile(path.join(repo, '*.log'), 'selected')
  await writeFile(path.join(repo, 'keep.log'), 'keep')
  execFileSync('git', ['add', '*.log', 'keep.log'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo })
  await writeFile(path.join(repo, '*.log'), 'selected modified')
  await writeFile(path.join(repo, 'keep.log'), 'keep modified')
  return repo
}

function gitNames(repo: string, args: string[]): string[] {
  const stdout = execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  return stdout.split(/\r?\n/).filter(Boolean)
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('git status pathspec literals', () => {
  it('stages a tracked path with Git glob characters as one literal path', async () => {
    const repo = await createRepoWithGlobNamedFiles()

    await stageFile(repo, '*.log')

    expect(gitNames(repo, ['diff', '--cached', '--name-only'])).toEqual(['*.log'])
    expect(gitNames(repo, ['diff', '--name-only'])).toEqual(['keep.log'])
  })

  it('bulk stages tracked paths with Git glob characters as literal paths', async () => {
    const repo = await createRepoWithGlobNamedFiles()

    await bulkStageFiles(repo, ['*.log'])

    expect(gitNames(repo, ['diff', '--cached', '--name-only'])).toEqual(['*.log'])
    expect(gitNames(repo, ['diff', '--name-only'])).toEqual(['keep.log'])
  })

  it('unstages a tracked path with Git glob characters as one literal path', async () => {
    const repo = await createRepoWithGlobNamedFiles()
    execFileSync('git', ['add', '*.log', 'keep.log'], { cwd: repo })

    await unstageFile(repo, '*.log')

    expect(gitNames(repo, ['diff', '--cached', '--name-only'])).toEqual(['keep.log'])
    expect(gitNames(repo, ['diff', '--name-only'])).toEqual(['*.log'])
  })

  it('bulk unstages tracked paths with Git glob characters as literal paths', async () => {
    const repo = await createRepoWithGlobNamedFiles()
    execFileSync('git', ['add', '*.log', 'keep.log'], { cwd: repo })

    await bulkUnstageFiles(repo, ['*.log'])

    expect(gitNames(repo, ['diff', '--cached', '--name-only'])).toEqual(['keep.log'])
    expect(gitNames(repo, ['diff', '--name-only'])).toEqual(['*.log'])
  })
})
