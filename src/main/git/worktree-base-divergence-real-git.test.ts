import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from '../../shared/git-fetch-auto-maintenance'
import {
  measureRetargetDivergence,
  RETARGET_MAX_COMMIT_DIVERGENCE
} from './worktree-base-divergence'

const tempRoots: string[] = []
let fixtureHome: string

function fixtureGitEnvironment(inheritedEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(inheritedEnv).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    ),
    HOME: fixtureHome,
    USERPROFILE: fixtureHome,
    XDG_CONFIG_HOME: fixtureHome,
    GIT_CONFIG_GLOBAL: join(fixtureHome, '.gitconfig'),
    GIT_CONFIG_SYSTEM: join(fixtureHome, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1'
  }
}

// Disable detached maintenance so commit-graph writes cannot race fixture teardown.
function git(cwd: string, args: string[], inheritedEnv = process.env): string {
  return execFileSync('git', [...GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS, ...args], {
    cwd,
    env: fixtureGitEnvironment(inheritedEnv),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

async function createRepo(inheritedEnv = process.env): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-base-divergence-'))
  tempRoots.push(root)
  const repoPath = join(root, 'repo')
  git(root, ['init', '--quiet', repoPath], inheritedEnv)
  expect(
    realpathSync.native(git(repoPath, ['rev-parse', '--absolute-git-dir'], inheritedEnv))
  ).toBe(realpathSync.native(join(repoPath, '.git')))
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'], inheritedEnv)
  git(repoPath, ['config', 'user.email', 'test@example.com'], inheritedEnv)
  git(repoPath, ['config', 'user.name', 'Test User'], inheritedEnv)
  await writeFile(join(repoPath, 'version.txt'), 'one\n')
  git(repoPath, ['add', 'version.txt'], inheritedEnv)
  git(repoPath, ['commit', '--quiet', '-m', 'initial'], inheritedEnv)
  return repoPath
}

// Unique messages prevent same-second empty commits from reusing the same hash after reset.
let emptyCommitSequence = 0

function commitEmpty(repoPath: string, count: number, inheritedEnv = process.env): void {
  const tree = git(repoPath, ['write-tree'], inheritedEnv)
  let parent = git(repoPath, ['rev-parse', 'HEAD'], inheritedEnv)
  for (let index = 0; index < count; index += 1) {
    emptyCommitSequence += 1
    parent = git(
      repoPath,
      ['commit-tree', tree, '-p', parent, '-m', `commit ${emptyCommitSequence}`],
      inheritedEnv
    )
  }
  expect(
    realpathSync.native(git(repoPath, ['rev-parse', '--absolute-git-dir'], inheritedEnv))
  ).toBe(realpathSync.native(join(repoPath, '.git')))
  git(repoPath, ['update-ref', 'HEAD', parent], inheritedEnv)
}

beforeEach(async () => {
  fixtureHome = await mkdtemp(join(tmpdir(), 'orca-base-divergence-home-'))
  tempRoots.push(fixtureHome)
  await writeFile(join(fixtureHome, '.gitconfig'), '')
  const env = fixtureGitEnvironment()
  for (const key of new Set([...Object.keys(process.env), ...Object.keys(env)])) {
    if (process.env[key] !== env[key]) {
      vi.stubEnv(key, env[key])
    }
  }
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('measureRetargetDivergence with real Git', () => {
  it.each(['repository pointers', 'config overrides'] as const)(
    'keeps the caller repository unchanged with inherited Git %s',
    async (contamination) => {
      const caller = await createRepo()
      const paths = ['HEAD', 'config', 'index'].map((name) => join(caller, '.git', name))
      const before = await Promise.all(paths.map((path) => readFile(path)))
      const refsBefore = git(caller, ['show-ref'])
      const inheritedGitEnv =
        contamination === 'repository pointers'
          ? {
              GIT_DIR: join(caller, '.git'),
              GIT_WORK_TREE: caller,
              GIT_COMMON_DIR: join(caller, '.git'),
              GIT_INDEX_FILE: join(caller, '.git', 'index'),
              GIT_OBJECT_DIRECTORY: join(caller, '.git', 'objects'),
              GIT_ALTERNATE_OBJECT_DIRECTORIES: join(caller, '.git', 'objects')
            }
          : {
              GIT_CONFIG: join(caller, '.git', 'config'),
              GIT_CONFIG_PARAMETERS: "'user.name=Injected Author'",
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'core.bare',
              GIT_CONFIG_VALUE_0: 'true'
            }
      const inheritedEnv = { ...process.env, ...inheritedGitEnv }
      const fixture = await createRepo(inheritedEnv)
      git(fixture, ['update-ref', 'refs/remotes/origin/main', 'HEAD'], inheritedEnv)
      commitEmpty(fixture, 2, inheritedEnv)

      await expect(
        measureRetargetDivergence(fixture, 'refs/remotes/origin/main', 'refs/heads/main')
      ).resolves.toBe('within')
      expect(git(fixture, ['rev-list', '--count', 'HEAD'])).toBe('3')
      expect(git(fixture, ['show', '-s', '--format=%an <%ae>', 'HEAD'])).toBe(
        'Test User <test@example.com>'
      )
      expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before)
      expect(git(caller, ['show-ref'])).toBe(refsBefore)
      expect(await readFile(join(caller, 'version.txt'), 'utf8')).toBe('one\n')
    }
  )

  it('keeps fixture commits independent of host commit signing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-divergence-signing-home-'))
    tempRoots.push(home)
    const config = join(home, '.gitconfig')
    const contents = `[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = ${JSON.stringify(join(home, 'missing-signer'))}\n`
    await writeFile(config, contents)
    const emptyConfig = join(home, 'empty-config')
    await writeFile(emptyConfig, '')
    const inheritedEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: config
    }

    const fixture = await createRepo(inheritedEnv)
    commitEmpty(fixture, 2, inheritedEnv)

    expect(git(fixture, ['rev-list', '--count', 'HEAD'], inheritedEnv)).toBe('3')
    expect(await readFile(config, 'utf8')).toBe(contents)
    expect(await readFile(emptyConfig, 'utf8')).toBe('')
  })

  it('allows the drift between a local branch and its remote-tracking copy', async () => {
    const repoPath = await createRepo()
    git(repoPath, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    commitEmpty(repoPath, 5)
    git(repoPath, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(repoPath, ['reset', '--hard', '--quiet', 'HEAD~3'])

    await expect(
      measureRetargetDivergence(repoPath, 'refs/heads/main', 'refs/remotes/origin/main')
    ).resolves.toBe('within')
  })

  it('counts drift in both directions', async () => {
    const repoPath = await createRepo()
    const forkPoint = git(repoPath, ['rev-parse', 'HEAD'])
    commitEmpty(repoPath, RETARGET_MAX_COMMIT_DIVERGENCE)
    git(repoPath, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(repoPath, ['reset', '--hard', '--quiet', forkPoint])
    commitEmpty(repoPath, 1)

    await expect(
      measureRetargetDivergence(repoPath, 'refs/heads/main', 'refs/remotes/origin/main')
    ).resolves.toBe('exceeded')
  })

  it('refuses a base that has drifted past the cap', async () => {
    const repoPath = await createRepo()
    git(repoPath, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    commitEmpty(repoPath, RETARGET_MAX_COMMIT_DIVERGENCE + 1)

    await expect(
      measureRetargetDivergence(repoPath, 'refs/remotes/origin/main', 'refs/heads/main')
    ).resolves.toBe('exceeded')
  })

  it('refuses unrelated histories, which share no commits at all', async () => {
    const repoPath = await createRepo()
    git(repoPath, ['checkout', '--quiet', '--orphan', 'unrelated'])
    git(repoPath, ['commit', '--quiet', '--allow-empty', '-m', 'unrelated root'])

    await expect(
      measureRetargetDivergence(repoPath, 'refs/heads/main', 'refs/heads/unrelated')
    ).resolves.toBe('exceeded')
  })

  it('reports an unreadable ref as unverifiable, not as excess drift', async () => {
    const repoPath = await createRepo()

    await expect(
      measureRetargetDivergence(repoPath, 'refs/heads/main', 'refs/heads/missing')
    ).resolves.toBe('unknown')
  })
})
