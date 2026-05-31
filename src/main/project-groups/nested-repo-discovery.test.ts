import { mkdtemp, mkdir, writeFile, rm, symlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { scanNestedRepos } from './nested-repo-discovery'

let tempDirs: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-nested-repos-'))
  tempDirs.push(dir)
  return dir
}

async function makeGitRepo(path: string): Promise<void> {
  await mkdir(join(path, '.git'), { recursive: true })
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('scanNestedRepos', () => {
  it('returns child repos for a non-git parent', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'auth-service'), { recursive: true })
    await mkdir(join(root, 'billing-service'), { recursive: true })
    await makeGitRepo(join(root, 'auth-service'))
    await makeGitRepo(join(root, 'billing-service'))

    const result = await scanNestedRepos({ path: root })

    expect(result.selectedPathKind).toBe('non_git_folder')
    expect(result.repos.map((repo) => repo.displayName)).toEqual([
      'auth-service',
      'billing-service'
    ])
  })

  it('does not scan inside an already discovered repo', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'service', 'nested'), { recursive: true })
    await makeGitRepo(join(root, 'service'))
    await makeGitRepo(join(root, 'service', 'nested'))

    const result = await scanNestedRepos({ path: root })

    expect(result.repos.map((repo) => repo.displayName)).toEqual(['service'])
  })

  it('skips heavy directories and respects result caps', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true })
    await mkdir(join(root, 'one'), { recursive: true })
    await mkdir(join(root, 'two'), { recursive: true })
    await makeGitRepo(join(root, 'node_modules', 'ignored'))
    await makeGitRepo(join(root, 'one'))
    await makeGitRepo(join(root, 'two'))

    const result = await scanNestedRepos({ path: root, options: { maxRepos: 1 } })

    expect(result.repos[0].displayName).toBe('one')
    expect(result.truncated).toBe(true)
  })

  it('treats a selected git repo as the existing repo path', async () => {
    const root = await tempRoot()
    await makeGitRepo(root)
    await mkdir(join(root, 'child'), { recursive: true })
    await makeGitRepo(join(root, 'child'))
    await writeFile(join(root, 'README.md'), '')

    const result = await scanNestedRepos({ path: root })

    expect(result.selectedPathKind).toBe('git_repo')
    expect(result.repos).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'does not follow symlinked directories outside the selected folder',
    async () => {
      const root = await tempRoot()
      const external = await tempRoot()
      await mkdir(join(external, 'outside-repo'), { recursive: true })
      await makeGitRepo(join(external, 'outside-repo'))
      await symlink(external, join(root, 'linked'), 'dir')

      const result = await scanNestedRepos({ path: root })

      expect(result.repos).toEqual([])
    }
  )
})
