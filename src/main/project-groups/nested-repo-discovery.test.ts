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

async function makeBareGitRepo(path: string): Promise<void> {
  await mkdir(join(path, 'objects'), { recursive: true })
  await mkdir(join(path, 'refs'), { recursive: true })
  await writeFile(join(path, 'HEAD'), 'ref: refs/heads/main\n')
}

function posixTestFilesystem(args: {
  directories: Map<string, string[]>
  gitRepos: Set<string>
  files?: Map<string, string>
}) {
  return {
    readDirectory: async (dirPath: string) =>
      (args.directories.get(dirPath) ?? []).map((name) => ({
        name,
        isDirectory: !args.files?.has(`${dirPath}/${name}`)
      })),
    readTextFile: async (path: string) => {
      const content = args.files?.get(path)
      if (content === undefined) {
        throw new Error('not found')
      }
      return content
    },
    joinPath: (parentPath: string, childName: string) => `${parentPath}/${childName}`,
    basename: (path: string) => path.split('/').at(-1) ?? path,
    hasGitMarker: (path: string) => args.gitRepos.has(path),
    isSelectedPathGitRepo: (path: string) => args.gitRepos.has(path)
  }
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

  it('prefers shallow sibling repos before descending into non-repo folders', async () => {
    const directories = new Map([
      ['/workspace', ['archive', 'z-web-client']],
      [
        '/workspace/archive',
        Array.from(
          { length: 101 },
          (_, index) => `archived-service-${String(index + 1).padStart(3, '0')}`
        )
      ]
    ])
    const gitRepos = new Set([
      '/workspace/z-web-client',
      ...Array.from(
        { length: 101 },
        (_, index) => `/workspace/archive/archived-service-${String(index + 1).padStart(3, '0')}`
      )
    ])

    const result = await scanNestedRepos({
      path: '/workspace',
      options: { maxRepos: 100 },
      filesystem: posixTestFilesystem({ directories, gitRepos })
    })

    expect(result.repos).toHaveLength(100)
    expect(result.repos[0].path).toBe('/workspace/z-web-client')
    expect(result.repos.map((repo) => repo.path)).toContain('/workspace/z-web-client')
    expect(result.truncated).toBe(true)
  })

  it('orders discovered repos by BFS parent queue and alphabetical children per directory', async () => {
    const directories = new Map([
      ['/workspace', ['omega-root', 'gamma-folder', 'beta-root', 'alpha-folder']],
      ['/workspace/alpha-folder', ['z-alpha-child', 'm-alpha-child', 'alpha-nested']],
      ['/workspace/gamma-folder', ['a-gamma-child']],
      ['/workspace/alpha-folder/alpha-nested', ['a-alpha-grandchild']]
    ])
    const gitRepos = new Set([
      '/workspace/beta-root',
      '/workspace/omega-root',
      '/workspace/alpha-folder/m-alpha-child',
      '/workspace/alpha-folder/z-alpha-child',
      '/workspace/gamma-folder/a-gamma-child',
      '/workspace/alpha-folder/alpha-nested/a-alpha-grandchild'
    ])
    const readOrder: string[] = []

    const result = await scanNestedRepos({
      path: '/workspace',
      filesystem: {
        ...posixTestFilesystem({ directories, gitRepos }),
        readDirectory: async (dirPath) => {
          readOrder.push(dirPath)
          return (directories.get(dirPath) ?? []).map((name) => ({ name, isDirectory: true }))
        }
      }
    })

    expect(readOrder).toEqual([
      '/workspace',
      '/workspace/alpha-folder',
      '/workspace/gamma-folder',
      '/workspace/alpha-folder/alpha-nested'
    ])
    expect(result.repos.map((repo) => repo.path)).toEqual([
      '/workspace/beta-root',
      '/workspace/omega-root',
      '/workspace/alpha-folder/m-alpha-child',
      '/workspace/alpha-folder/z-alpha-child',
      '/workspace/gamma-folder/a-gamma-child',
      '/workspace/alpha-folder/alpha-nested/a-alpha-grandchild'
    ])
    expect(result.repos.map((repo) => repo.depth)).toEqual([1, 1, 2, 2, 2, 3])
  })

  it('uses gitignore rules to avoid scanning ignored directories', async () => {
    const directories = new Map([
      ['/workspace', ['.gitignore', 'active', 'ignored']],
      ['/workspace/active', ['repo']],
      ['/workspace/ignored', ['repo']]
    ])
    const files = new Map([['/workspace/.gitignore', 'ignored/\n']])
    const gitRepos = new Set(['/workspace/active/repo', '/workspace/ignored/repo'])

    const result = await scanNestedRepos({
      path: '/workspace',
      filesystem: posixTestFilesystem({ directories, gitRepos, files })
    })

    expect(result.repos.map((repo) => repo.path)).toEqual(['/workspace/active/repo'])
  })

  it('keeps root-anchored gitignore rules scoped to their base directory', async () => {
    const directories = new Map([
      ['/workspace', ['.gitignore', 'active', 'ignored']],
      ['/workspace/active', ['ignored']],
      ['/workspace/active/ignored', ['repo']],
      ['/workspace/ignored', ['repo']]
    ])
    const files = new Map([['/workspace/.gitignore', '/ignored\n']])
    const gitRepos = new Set(['/workspace/active/ignored/repo', '/workspace/ignored/repo'])

    const result = await scanNestedRepos({
      path: '/workspace',
      filesystem: posixTestFilesystem({ directories, gitRepos, files })
    })

    expect(result.repos.map((repo) => repo.path)).toEqual(['/workspace/active/ignored/repo'])
  })

  it('detects bare child repositories without scanning inside them', async () => {
    const root = await tempRoot()
    await makeBareGitRepo(join(root, 'mirror.git'))
    await mkdir(join(root, 'mirror.git', 'refs', 'nested-repo'), { recursive: true })
    await makeGitRepo(join(root, 'mirror.git', 'refs', 'nested-repo'))

    const result = await scanNestedRepos({ path: root })

    expect(result.repos.map((repo) => repo.displayName)).toEqual(['mirror.git'])
  })

  it('does not use selected-path git checks while traversing children', async () => {
    const directories = new Map([
      ['/workspace', ['repo']],
      ['/workspace/repo', []]
    ])
    const gitRepos = new Set(['/workspace/repo'])
    const selectedPathChecks: string[] = []

    const result = await scanNestedRepos({
      path: '/workspace',
      filesystem: {
        ...posixTestFilesystem({ directories, gitRepos }),
        isSelectedPathGitRepo: (path) => {
          selectedPathChecks.push(path)
          return false
        }
      }
    })

    expect(result.repos.map((repo) => repo.path)).toEqual(['/workspace/repo'])
    expect(selectedPathChecks).toEqual(['/workspace'])
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
