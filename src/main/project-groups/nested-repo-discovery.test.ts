import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  vi.restoreAllMocks()
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
    expect(result.timeoutMs).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.repos.map((repo) => repo.displayName)).toEqual([
      'auth-service',
      'billing-service'
    ])
  })

  it('returns repositories found before a stopped scan', async () => {
    const directories = new Map([['/workspace', ['api', 'web']]])
    const gitRepos = new Set(['/workspace/api', '/workspace/web'])
    const controller = new AbortController()

    const result = await scanNestedRepos({
      path: '/workspace',
      signal: controller.signal,
      onProgress: (scan) => {
        if (scan.repos.length === 1) {
          controller.abort()
        }
      },
      filesystem: posixTestFilesystem({ directories, gitRepos })
    })

    expect(result).toMatchObject({
      selectedPathKind: 'non_git_folder',
      stopped: true,
      timedOut: false,
      truncated: false
    })
    expect(result.repos.map((repo) => repo.path)).toEqual(['/workspace/api'])
  })

  it('returns stopped with no repos when cancelled before traversal', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await scanNestedRepos({
      path: '/workspace',
      signal: controller.signal,
      filesystem: posixTestFilesystem({
        directories: new Map([['/workspace', ['api']]]),
        gitRepos: new Set(['/workspace/api'])
      })
    })

    expect(result).toMatchObject({
      selectedPathKind: 'non_git_folder',
      repos: [],
      stopped: true,
      timedOut: false,
      truncated: false
    })
  })

  it('emits immutable progress snapshots as repositories are discovered', async () => {
    const progress: { repos: { path: string }[] }[] = []

    const result = await scanNestedRepos({
      path: '/workspace',
      onProgress: (scan) => progress.push(scan),
      filesystem: posixTestFilesystem({
        directories: new Map([['/workspace', ['api', 'web']]]),
        gitRepos: new Set(['/workspace/api', '/workspace/web'])
      })
    })

    expect(result.repos.map((repo) => repo.path)).toEqual(['/workspace/api', '/workspace/web'])
    expect(progress.map((scan) => scan.repos.map((repo) => repo.path))).toEqual([
      ['/workspace/api'],
      ['/workspace/api', '/workspace/web']
    ])
    expect(progress[0].repos).toHaveLength(1)
  })

  it('does not time out by default even when elapsed time grows', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(60_000)

    const result = await scanNestedRepos({
      path: '/workspace',
      filesystem: posixTestFilesystem({
        directories: new Map([['/workspace', ['api']]]),
        gitRepos: new Set(['/workspace/api'])
      })
    })

    expect(result).toMatchObject({
      timedOut: false,
      timeoutMs: null,
      repos: [{ path: '/workspace/api' }]
    })
  })

  it('still honors an explicit timeout option for callers that request one', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(1_000)

    const result = await scanNestedRepos({
      path: '/workspace',
      options: { timeoutMs: 500 },
      filesystem: posixTestFilesystem({
        directories: new Map([['/workspace', ['api']]]),
        gitRepos: new Set(['/workspace/api'])
      })
    })

    expect(result).toMatchObject({
      repos: [],
      stopped: false,
      timedOut: true,
      timeoutMs: 500
    })
  })

  it('does not scan inside an already discovered repo', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'service', 'nested'), { recursive: true })
    await makeGitRepo(join(root, 'service'))
    await makeGitRepo(join(root, 'service', 'nested'))

    const result = await scanNestedRepos({ path: root })

    expect(result.repos.map((repo) => repo.displayName)).toEqual(['service'])
  })

  it('skips symlinked directories reported by remote filesystems', async () => {
    const result = await scanNestedRepos({
      path: '/workspace',
      filesystem: {
        readDirectory: async (dirPath) =>
          dirPath === '/workspace'
            ? [
                { name: 'linked-outside', isDirectory: true, isSymlink: true },
                { name: 'api', isDirectory: true, isSymlink: false }
              ]
            : [],
        joinPath: (parentPath, childName) => `${parentPath}/${childName}`,
        basename: (path) => path.split('/').at(-1) ?? path,
        hasGitMarker: (path) => path === '/workspace/api',
        isSelectedPathGitRepo: () => false
      }
    })

    expect(result.repos.map((repo) => repo.path)).toEqual(['/workspace/api'])
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

  it('discovers gitignored nested repos when repos-inside-repos is on', async () => {
    const directories = new Map([
      ['/workspace', ['.gitignore', 'api', 'poc', 'node_modules']],
      ['/workspace/api', ['nested']],
      // Why: the real shape — an ignored plain folder holding an ignored clone.
      ['/workspace/poc', ['experiment']],
      ['/workspace/node_modules', ['dep-clone']]
    ])
    const files = new Map([['/workspace/.gitignore', 'api/\npoc/\n']])
    const gitRepos = new Set([
      '/workspace',
      '/workspace/api',
      '/workspace/api/nested',
      '/workspace/poc/experiment',
      '/workspace/node_modules/dep-clone'
    ])

    const result = await scanNestedRepos({
      path: '/workspace',
      options: { includeReposInsideGitRepos: true },
      filesystem: posixTestFilesystem({ directories, gitRepos, files })
    })

    // node_modules stays pruned: SKIPPED_DIRS is independent of gitignore.
    expect(result.repos.map((repo) => repo.path)).toEqual([
      '/workspace',
      '/workspace/api',
      '/workspace/api/nested',
      '/workspace/poc/experiment'
    ])
  })

  it('marks candidates registered in an enclosing .gitmodules', async () => {
    const directories = new Map([
      ['/workspace', ['api', 'web']],
      // Why: the real shape — the submodule is declared by the child repo that
      // owns it, not by the folder the user selected.
      ['/workspace/api', ['.gitmodules', 'design', 'clone']],
      ['/workspace/web', []]
    ])
    const files = new Map([
      [
        '/workspace/api/.gitmodules',
        '[submodule "design"]\n\tpath = design\n\turl = git@host:design\n'
      ]
    ])
    const gitRepos = new Set([
      '/workspace',
      '/workspace/api',
      '/workspace/web',
      '/workspace/api/design',
      '/workspace/api/clone'
    ])

    const result = await scanNestedRepos({
      path: '/workspace',
      options: { includeReposInsideGitRepos: true },
      filesystem: posixTestFilesystem({ directories, gitRepos, files })
    })

    expect(result.repos).toEqual([
      { path: '/workspace', displayName: 'workspace', depth: 0 },
      { path: '/workspace/api', displayName: 'api', depth: 1 },
      { path: '/workspace/web', displayName: 'web', depth: 1 },
      // Only the declared path is a submodule; its sibling clone is not.
      { path: '/workspace/api/clone', displayName: 'clone', depth: 2 },
      { path: '/workspace/api/design', displayName: 'design', depth: 2, isSubmodule: true }
    ])
  })

  it('resolves nested .gitmodules paths against the declaring repo', async () => {
    const directories = new Map([
      ['/workspace', ['.gitmodules', 'third-party']],
      ['/workspace/third-party', ['lib']],
      ['/workspace/third-party/lib', []]
    ])
    const files = new Map([
      ['/workspace/.gitmodules', '[submodule "lib"]\n\tpath = third-party/lib\n']
    ])
    const gitRepos = new Set(['/workspace', '/workspace/third-party/lib'])

    const result = await scanNestedRepos({
      path: '/workspace',
      options: { includeReposInsideGitRepos: true },
      filesystem: posixTestFilesystem({ directories, gitRepos, files })
    })

    // Why no parent entry: a submodule is not an importable discovery, so a repo
    // whose only nested repos are its own submodules stays a plain repo.
    expect(result.repos).toEqual([
      { path: '/workspace/third-party/lib', displayName: 'lib', depth: 2, isSubmodule: true }
    ])
  })

  it('lists a submodule alongside a real nested clone without letting it stand alone', async () => {
    const directories = new Map([
      ['/workspace', ['.gitmodules', 'clone', 'design']],
      ['/workspace/clone', []],
      ['/workspace/design', []]
    ])
    const files = new Map([['/workspace/.gitmodules', '[submodule "design"]\n\tpath = design\n']])
    const gitRepos = new Set(['/workspace', '/workspace/clone', '/workspace/design'])

    const result = await scanNestedRepos({
      path: '/workspace',
      options: { includeReposInsideGitRepos: true },
      filesystem: posixTestFilesystem({ directories, gitRepos, files })
    })

    // The clone justifies the review, so the parent joins and the submodule is
    // listed for the user to opt into.
    expect(result.repos).toEqual([
      { path: '/workspace', displayName: 'workspace', depth: 0 },
      { path: '/workspace/clone', displayName: 'clone', depth: 1 },
      { path: '/workspace/design', displayName: 'design', depth: 1, isSubmodule: true }
    ])
  })

  it('reads path only inside a submodule section', async () => {
    const directories = new Map([
      ['/workspace', ['.gitmodules', 'clone', 'design']],
      ['/workspace/clone', []],
      ['/workspace/design', []]
    ])
    // Why: a `path` outside [submodule "…"], or one commented out, is not a
    // submodule declaration — treating it as one would drop an independent repo
    // from the default import selection.
    const files = new Map([
      [
        '/workspace/.gitmodules',
        '[core]\n\tpath = clone\n[submodule "design"]\n\t# path = stale\n\tpath = design\n'
      ]
    ])
    const gitRepos = new Set(['/workspace', '/workspace/clone', '/workspace/design'])

    const result = await scanNestedRepos({
      path: '/workspace',
      options: { includeReposInsideGitRepos: true },
      filesystem: posixTestFilesystem({ directories, gitRepos, files })
    })

    expect(result.repos).toEqual([
      { path: '/workspace', displayName: 'workspace', depth: 0 },
      { path: '/workspace/clone', displayName: 'clone', depth: 1 },
      { path: '/workspace/design', displayName: 'design', depth: 1, isSubmodule: true }
    ])
  })

  it('excludes repos an agent CLI minted under its own scratch roots', async () => {
    // Why: a repo registered at such a root is agent-internal, not a user
    // project (#9388), and it would otherwise arrive pre-ticked for import.
    const directories = new Map([
      ['/workspace', ['.codex-tmp', 'api']],
      ['/workspace/.codex-tmp', ['scratch']],
      ['/workspace/api', []]
    ])
    const gitRepos = new Set(['/workspace', '/workspace/api', '/workspace/.codex-tmp/scratch'])

    const result = await scanNestedRepos({
      path: '/workspace',
      options: { includeReposInsideGitRepos: true },
      filesystem: posixTestFilesystem({ directories, gitRepos })
    })

    expect(result.repos.map((repo) => repo.path)).toEqual(['/workspace', '/workspace/api'])
  })

  it('bounds a repos-inside-repos scan with a default timeout', async () => {
    const result = await scanNestedRepos({
      path: '/workspace',
      options: { includeReposInsideGitRepos: true },
      filesystem: posixTestFilesystem({
        directories: new Map([['/workspace', []]]),
        gitRepos: new Set(['/workspace'])
      })
    })

    expect(result.timeoutMs).toBe(10_000)
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

  it('finds repos nested inside the selected repo when asked', async () => {
    const root = await tempRoot()
    await makeGitRepo(root)
    await mkdir(join(root, 'packages', 'api'), { recursive: true })
    await mkdir(join(root, 'packages', 'web'), { recursive: true })
    await makeGitRepo(join(root, 'packages', 'api'))
    await makeGitRepo(join(root, 'packages', 'web'))

    const result = await scanNestedRepos({
      path: root,
      options: { includeReposInsideGitRepos: true }
    })

    expect(result.selectedPathKind).toBe('git_repo')
    expect(result.repos.map((repo) => repo.displayName)).toEqual([basename(root), 'api', 'web'])
    expect(result.repos[0]).toEqual({ path: root, displayName: basename(root), depth: 0 })
  })

  it('leaves a selected repo with no nested repos out of the candidate list', async () => {
    const root = await tempRoot()
    await makeGitRepo(root)
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'README.md'), '')

    const result = await scanNestedRepos({
      path: root,
      options: { includeReposInsideGitRepos: true }
    })

    expect(result.selectedPathKind).toBe('git_repo')
    expect(result.repos).toEqual([])
  })

  it('descends into discovered repos when asked', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'service', 'libs', 'sdk'), { recursive: true })
    await makeGitRepo(join(root, 'service'))
    await makeGitRepo(join(root, 'service', 'libs', 'sdk'))

    const result = await scanNestedRepos({
      path: root,
      options: { includeReposInsideGitRepos: true }
    })

    expect(result.selectedPathKind).toBe('non_git_folder')
    expect(result.repos.map((repo) => repo.displayName)).toEqual(['service', 'sdk'])
  })

  it('does not count the selected repo against the result cap', async () => {
    const root = await tempRoot()
    await makeGitRepo(root)
    await mkdir(join(root, 'one'), { recursive: true })
    await mkdir(join(root, 'two'), { recursive: true })
    await makeGitRepo(join(root, 'one'))
    await makeGitRepo(join(root, 'two'))

    const result = await scanNestedRepos({
      path: root,
      options: { includeReposInsideGitRepos: true, maxRepos: 1 }
    })

    expect(result.truncated).toBe(true)
    expect(result.repos.map((repo) => repo.displayName)).toEqual([basename(root), 'one'])
  })

  it('includes the selected repo in progress snapshots', async () => {
    const root = await tempRoot()
    await makeGitRepo(root)
    await mkdir(join(root, 'child'), { recursive: true })
    await makeGitRepo(join(root, 'child'))
    const snapshots: string[][] = []

    await scanNestedRepos({
      path: root,
      options: { includeReposInsideGitRepos: true },
      onProgress: (scan) => snapshots.push(scan.repos.map((repo) => repo.displayName))
    })

    expect(snapshots).toEqual([[basename(root), 'child']])
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
