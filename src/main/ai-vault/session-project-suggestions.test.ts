import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '../../shared/child-process/run-process'
import { suggestProjectsFromSessions, type ResolveGitRoot } from './session-project-suggestions'

function git(cwd: string, ...args: string[]): string {
  const result = runProcessSync({
    program: 'git',
    args: ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    cwd
  })
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

const resolveGitRoot: ResolveGitRoot = async (cwd) => {
  const result = runProcessSync({
    program: 'git',
    args: ['rev-parse', '--show-toplevel', '--git-common-dir'],
    cwd
  })
  if (result.code !== 0) {
    return null
  }
  const [toplevel, commonDir] = result.stdout.split('\n').map((line) => line.trim())
  return { toplevel, commonDir }
}

describe('suggestProjectsFromSessions', () => {
  let root = ''
  let home = ''
  let repo = ''
  let worktree = ''
  let plainFolder = ''

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-session-projects-')))
    home = join(root, 'home')
    repo = join(home, 'Projects', 'app')
    worktree = join(home, 'Projects', 'app-worktrees', 'feature')
    plainFolder = join(home, 'Notes')
    mkdirSync(repo, { recursive: true })
    mkdirSync(plainFolder, { recursive: true })
    git(repo, 'init', '-q')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(repo, 'worktree', 'add', '-q', worktree)
    mkdirSync(join(repo, 'src'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const baseInput = () => ({
    registeredRepoPaths: [],
    dismissedPaths: [],
    homeDir: home,
    tempDirs: [join(root, 'scratch')]
  })

  it('folds subfolders and linked worktrees into one suggestion for the main repo', async () => {
    const suggestions = await suggestProjectsFromSessions(
      {
        ...baseInput(),
        sources: [
          { cwd: repo, agent: 'claude' },
          { cwd: join(repo, 'src'), agent: 'claude' },
          { cwd: worktree, agent: 'codex' }
        ]
      },
      resolveGitRoot
    )

    expect(suggestions).toEqual([
      { path: repo, name: 'app', sessionCount: 3, agents: ['claude', 'codex'] }
    ])
  })

  it('skips plain folders, missing folders, home, temp dirs and ~/.cache', async () => {
    const cacheRepo = join(home, '.cache', 'bench')
    mkdirSync(cacheRepo, { recursive: true })
    git(cacheRepo, 'init', '-q')
    const scratchRepo = join(root, 'scratch', 'run')
    mkdirSync(scratchRepo, { recursive: true })
    git(scratchRepo, 'init', '-q')

    const suggestions = await suggestProjectsFromSessions(
      {
        ...baseInput(),
        sources: [
          { cwd: plainFolder, agent: 'claude' },
          { cwd: join(home, 'gone'), agent: 'claude' },
          { cwd: home, agent: 'codex' },
          { cwd: cacheRepo, agent: 'claude' },
          { cwd: scratchRepo, agent: 'claude' },
          { cwd: 'relative/path', agent: 'claude' }
        ]
      },
      resolveGitRoot
    )

    expect(suggestions).toEqual([])
  })

  it('omits repos that are already projects or were dismissed', async () => {
    const other = join(home, 'Projects', 'other')
    mkdirSync(other, { recursive: true })
    git(other, 'init', '-q')
    const sources = [
      { cwd: repo, agent: 'claude' as const },
      { cwd: other, agent: 'codex' as const }
    ]

    const afterRegister = await suggestProjectsFromSessions(
      { ...baseInput(), registeredRepoPaths: [repo], sources },
      resolveGitRoot
    )
    const afterDismiss = await suggestProjectsFromSessions(
      { ...baseInput(), dismissedPaths: [other], sources },
      resolveGitRoot
    )

    expect(afterRegister.map((s) => s.path)).toEqual([other])
    expect(afterDismiss.map((s) => s.path)).toEqual([repo])
  })

  it.skipIf(process.platform === 'win32')(
    'applies exclusions and registered repos through a symlinked home',
    async () => {
      const linkedHome = join(root, 'linked-home')
      symlinkSync(home, linkedHome)
      const cacheRepo = join(home, '.cache', 'bench')
      mkdirSync(cacheRepo, { recursive: true })
      git(cacheRepo, 'init', '-q')

      const suggestions = await suggestProjectsFromSessions(
        {
          ...baseInput(),
          homeDir: linkedHome,
          registeredRepoPaths: [join(linkedHome, 'Projects', 'app')],
          sources: [
            { cwd: join(linkedHome, '.cache', 'bench'), agent: 'claude' },
            { cwd: join(linkedHome, 'Projects', 'app'), agent: 'codex' }
          ]
        },
        resolveGitRoot
      )

      expect(suggestions).toEqual([])
    }
  )

  it('drops a corrupted session folder without hiding valid suggestions', async () => {
    const suggestions = await suggestProjectsFromSessions(
      {
        ...baseInput(),
        sources: [
          { cwd: `${repo}\0broken`, agent: 'claude' },
          { cwd: `/${'x'.repeat(5000)}`, agent: 'claude' },
          { cwd: repo, agent: 'codex' }
        ]
      },
      resolveGitRoot
    )

    expect(suggestions.map((s) => s.path)).toEqual([repo])
  })

  it('keeps repos under home even when home itself is inside a temp dir', async () => {
    const suggestions = await suggestProjectsFromSessions(
      { ...baseInput(), tempDirs: [root], sources: [{ cwd: repo, agent: 'claude' }] },
      resolveGitRoot
    )

    expect(suggestions.map((s) => s.path)).toEqual([repo])
  })

  it('treats a resolver failure as not a repo', async () => {
    const suggestions = await suggestProjectsFromSessions(
      { ...baseInput(), sources: [{ cwd: repo, agent: 'claude' }] },
      async () => {
        throw new Error('git unavailable')
      }
    )

    expect(suggestions).toEqual([])
  })
})
