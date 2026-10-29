import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getStatus, stageFile } from './status'

const tempRoots: string[] = []

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'orca-status-cquoted-'))
  tempRoots.push(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo })
  return repo
}

function gitNames(repo: string, args: string[]): string[] {
  const stdout = execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  return stdout.split('\0').filter(Boolean)
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('git status C-quoted paths', () => {
  it('returns the real path for untracked UTF-8 filenames', async () => {
    const repo = await createRepo()
    const filePath = '日本語-file.txt'
    await writeFile(path.join(repo, filePath), 'new file\n')

    const status = await getStatus(repo)

    expect(status.entries).toEqual([
      { path: filePath, status: 'untracked', area: 'untracked', added: 1 }
    ])

    await stageFile(repo, status.entries[0].path)

    expect(gitNames(repo, ['diff', '--cached', '--name-only', '-z'])).toEqual([filePath])
  })
})
