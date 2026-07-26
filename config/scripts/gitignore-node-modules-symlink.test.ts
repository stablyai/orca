import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoGitignorePath = path.resolve('.gitignore')
const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// Why: asserting on the shipped .gitignore requires a throwaway repo; the real one already
// tracks nothing named node_modules, so there is no in-place way to observe the rule.
async function createRepoUsingShippedGitignore(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-gitignore-node-modules-'))
  tempRoots.push(root)
  const repo = path.join(root, 'repo')
  await mkdir(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  // Why: a developer's global excludes or the init template would otherwise decide the
  // outcome, hiding whether the shipped pattern is the thing doing the ignoring.
  execFileSync('git', ['config', 'core.excludesFile', ''], { cwd: repo })
  await writeFile(path.join(repo, '.git', 'info', 'exclude'), '')
  await writeFile(path.join(repo, '.gitignore'), await readFile(repoGitignorePath, 'utf8'))
  return repo
}

function isIgnored(repo: string, relativePath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relativePath], { cwd: repo })
    return true
  } catch {
    return false
  }
}

// Why: creating a symlink on Windows needs Developer Mode or elevation, but WSL and
// dev-container checkouts of this repo hit the shared-install layout that this guards.
describe.skipIf(process.platform === 'win32')('shipped .gitignore node_modules coverage', () => {
  it('ignores a node_modules symlink pointing at a shared install', async () => {
    const repo = await createRepoUsingShippedGitignore()
    const sharedInstall = path.join(repo, '..', 'shared-install')
    await mkdir(sharedInstall)
    await symlink(sharedInstall, path.join(repo, 'node_modules'), 'dir')

    expect(isIgnored(repo, 'node_modules')).toBe(true)
  })

  it('keeps a node_modules symlink out of git add -A', async () => {
    const repo = await createRepoUsingShippedGitignore()
    const sharedInstall = path.join(repo, '..', 'shared-install')
    await mkdir(sharedInstall)
    await symlink(sharedInstall, path.join(repo, 'node_modules'), 'dir')

    execFileSync('git', ['add', '-A'], { cwd: repo })
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: repo,
      encoding: 'utf8'
    })

    // Why: staging the link commits mode 120000 whose blob is an absolute local path.
    expect(staged.split('\n').filter(Boolean)).not.toContain('node_modules')
  })

  it('still ignores a real node_modules directory at the root and nested', async () => {
    const repo = await createRepoUsingShippedGitignore()
    await mkdir(path.join(repo, 'node_modules'))
    await mkdir(path.join(repo, 'packages', 'app', 'node_modules'), { recursive: true })

    expect(isIgnored(repo, 'node_modules')).toBe(true)
    expect(isIgnored(repo, 'packages/app/node_modules')).toBe(true)
  })

  // Why: paths under docs/ cannot be used as fixtures here — `docs/**` is ignored
  // wholesale by an unrelated rule, which would mask what this case is checking.
  it('does not ignore sources whose name merely contains node_modules', async () => {
    const repo = await createRepoUsingShippedGitignore()
    await mkdir(path.join(repo, 'packages', 'app'), { recursive: true })
    await writeFile(path.join(repo, 'packages', 'app', 'node_modules.md'), '')
    await mkdir(path.join(repo, 'node_modules_cache'))
    await writeFile(path.join(repo, 'node_modules_cache', 'entry.txt'), '')

    expect(isIgnored(repo, 'packages/app/node_modules.md')).toBe(false)
    expect(isIgnored(repo, 'node_modules_cache/entry.txt')).toBe(false)
  })
})
