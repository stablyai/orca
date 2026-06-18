import { execFileSync } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { bulkStageFiles, bulkUnstageFiles, stageFile, unstageFile } from './status'

const tempRoots: string[] = []
const globNamedFile = '[k]eep.log'
const globMatchedFile = 'keep.log'

function gitLiteralPathspec(filePath: string): string {
  return `:(literal)${filePath}`
}

async function createRepoWithGlobNamedFiles(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'orca-status-pathspec-'))
  tempRoots.push(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo })
  await writeFile(path.join(repo, globNamedFile), 'selected')
  await writeFile(path.join(repo, globMatchedFile), 'keep')
  execFileSync('git', ['add', gitLiteralPathspec(globNamedFile), globMatchedFile], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo })
  await writeFile(path.join(repo, globNamedFile), 'selected modified')
  await writeFile(path.join(repo, globMatchedFile), 'keep modified')
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

    await stageFile(repo, globNamedFile)

    expect(gitNames(repo, ['diff', '--cached', '--name-only'])).toEqual([globNamedFile])
    expect(gitNames(repo, ['diff', '--name-only'])).toEqual([globMatchedFile])
  })

  it('bulk stages tracked paths with Git glob characters as literal paths', async () => {
    const repo = await createRepoWithGlobNamedFiles()

    await bulkStageFiles(repo, [globNamedFile])

    expect(gitNames(repo, ['diff', '--cached', '--name-only'])).toEqual([globNamedFile])
    expect(gitNames(repo, ['diff', '--name-only'])).toEqual([globMatchedFile])
  })

  it('unstages a tracked path with Git glob characters as one literal path', async () => {
    const repo = await createRepoWithGlobNamedFiles()
    execFileSync('git', ['add', gitLiteralPathspec(globNamedFile), globMatchedFile], { cwd: repo })

    await unstageFile(repo, globNamedFile)

    expect(gitNames(repo, ['diff', '--cached', '--name-only'])).toEqual([globMatchedFile])
    expect(gitNames(repo, ['diff', '--name-only'])).toEqual([globNamedFile])
  })

  it('bulk unstages tracked paths with Git glob characters as literal paths', async () => {
    const repo = await createRepoWithGlobNamedFiles()
    execFileSync('git', ['add', gitLiteralPathspec(globNamedFile), globMatchedFile], { cwd: repo })

    await bulkUnstageFiles(repo, [globNamedFile])

    expect(gitNames(repo, ['diff', '--cached', '--name-only'])).toEqual([globMatchedFile])
    expect(gitNames(repo, ['diff', '--name-only'])).toEqual([globNamedFile])
  })
})
