// Real-binary coverage for repository Git tuning on the local host: the planner suites cannot
// prove that the config Orca writes, records and removes is what the user's Git reads back.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { GitTuningMode } from '../../shared/git-performance-config-types'
import { clearGitCapabilityStateForTests } from './git-capability-state'
import {
  applyRepoPerformanceConfigOnAdd,
  createLocalGitPerformanceConfigHost,
  runRepoPerformanceConfig,
  trackGitTuningSetting
} from './repo-performance-config'
import { GitCapabilityCache } from '../../shared/git-capability-cache'

const execFileAsync = promisify(execFile)

let scratchDir = ''
let repoPath = ''
let savedEnv: Record<string, string | undefined> = {}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath })
  return stdout
}

async function localValue(key: string): Promise<string | null> {
  try {
    return (await git(['config', '--local', '--get-all', key])).trim()
  } catch {
    return null
  }
}

function repoRecord(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: repoPath,
    displayName: 'repo',
    badgeColor: '#000000',
    addedAt: 0,
    kind: 'git',
    ...overrides
  }
}

async function gitMinor(): Promise<number> {
  const match = /git version 2\.(\d+)/.exec(await git(['--version']))
  return match ? Number(match[1]) : 0
}

beforeEach(async () => {
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-git-tuning-')))
  repoPath = join(scratchDir, 'repo')
  // Why: the developer's own ~/.gitconfig may already set these keys, which Orca must respect.
  const globalConfig = join(scratchDir, 'global.gitconfig')
  await writeFile(globalConfig, '')
  savedEnv = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM
  }
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q'])
  await git(['config', 'user.email', 'tuning@example.invalid'])
  await git(['config', 'user.name', 'Git Tuning'])
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'seed'])
})

afterEach(async () => {
  clearGitCapabilityStateForTests()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await rm(scratchDir, { recursive: true, force: true })
})

describe('repository Git tuning against the real Git binary', () => {
  it('applies only unset keys, records them, and reverts exactly what it recorded', async () => {
    await execFileAsync('git', ['config', '--global', 'checkout.workers', '4'], { cwd: repoPath })

    const applied = await runRepoPerformanceConfig(repoRecord(), 'apply')

    expect(applied.status).toBe('ok')
    expect(await localValue('fetch.writeCommitGraph')).toBe('true')
    expect(await localValue('checkout.workers')).toBeNull()
    expect(await localValue('index.version')).toBeNull()
    if (process.platform !== 'win32') {
      expect(await localValue('core.untrackedCache')).toBe('true')
    }
    // The file watcher is its own opt-in, so Recommended alone never sets it.
    expect(await localValue('core.fsmonitor')).toBeNull()
    expect(applied.status === 'ok' && applied.state.userKeys).toEqual(['checkout.workers'])
    expect((await localValue('orca.performanceConfig'))?.split('\n')).toContain(
      'fetch.writeCommitGraph=true'
    )

    // A value the user edits after Orca wrote it is theirs from then on.
    await git(['config', '--local', 'fetch.writeCommitGraph', 'false'])
    const reverted = await runRepoPerformanceConfig(repoRecord(), 'revert')

    expect(reverted.status === 'ok' && reverted.reverted).not.toContain('fetch.writeCommitGraph')
    expect(await localValue('fetch.writeCommitGraph')).toBe('false')
    expect(await localValue('core.untrackedCache')).toBeNull()
    expect(await localValue('core.fsmonitor')).toBeNull()
    expect(await localValue('orca.performanceConfig')).toBeNull()
  })

  it('sets the file watcher only with its opt-in, where the host supports it', async () => {
    const supported =
      (process.platform === 'darwin' || process.platform === 'win32') && (await gitMinor()) >= 37

    await runRepoPerformanceConfig(repoRecord(), 'apply', { fsmonitor: true })
    expect(await localValue('core.fsmonitor')).toBe(supported ? 'true' : null)

    const withdrawn = await runRepoPerformanceConfig(repoRecord(), 'revert', {
      keys: ['core.fsmonitor']
    })
    expect(withdrawn.status === 'ok' && withdrawn.reverted).toEqual(
      supported ? ['core.fsmonitor'] : []
    )
    expect(await localValue('core.fsmonitor')).toBeNull()
    expect(await localValue('fetch.writeCommitGraph')).toBe('true')
  })

  it('uses index v4 for repositories with at least 10,000 tracked entries', async () => {
    const blob = (await git(['hash-object', '-w', 'seed.txt'])).trim()
    const lines = Array.from(
      { length: 10_000 },
      (_, index) => `100644 ${blob} 0\tbulk/${index}.txt`
    )
    // Index entries without files on disk: the header count is all the plan reads.
    const child = execFile('git', ['update-index', '--index-info'], { cwd: repoPath })
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
    child.stdin?.end(`${lines.join('\n')}\n`)
    expect(await exited).toBe(0)

    await runRepoPerformanceConfig(repoRecord(), 'apply')

    expect(await localValue('index.version')).toBe('4')
  })

  it('applies on add only after the tracked setting turns Recommended, and reverts on Off', async () => {
    type Settings = { gitTuning?: GitTuningMode; gitTuningFsmonitor?: boolean }
    const settings: Settings = {}
    const listeners: ((updates: Settings) => void)[] = []
    const notify = (updates: Settings) => {
      Object.assign(settings, updates)
      listeners.forEach((listener) => listener(updates))
    }
    const changeSetting = (gitTuning: GitTuningMode | undefined) =>
      notify(gitTuning === undefined ? {} : { gitTuning })
    const untrack = trackGitTuningSetting({
      getSettings: () => settings,
      getRepos: () => [repoRecord(), repoRecord({ id: 'folder', kind: 'folder' })],
      onSettingsChanged: (listener) => {
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      }
    })
    try {
      applyRepoPerformanceConfigOnAdd(repoRecord())
      changeSetting('off')
      applyRepoPerformanceConfigOnAdd(repoRecord())
      // A read queued behind anything the calls above started proves nothing was written.
      await runRepoPerformanceConfig(repoRecord(), 'inspect')
      expect(await localValue('fetch.writeCommitGraph')).toBeNull()

      changeSetting('recommended')
      applyRepoPerformanceConfigOnAdd(repoRecord())
      await vi.waitFor(async () => expect(await localValue('fetch.writeCommitGraph')).toBe('true'))
      // Unrelated settings changes leave the config alone.
      changeSetting(undefined)
      await runRepoPerformanceConfig(repoRecord(), 'inspect')
      expect(await localValue('fetch.writeCommitGraph')).toBe('true')

      // Withdrawing the file-watcher opt-in reverts that key only.
      await git(['config', '--local', '--add', 'orca.performanceConfig', 'core.fsmonitor=true'])
      await git(['config', '--local', 'core.fsmonitor', 'true'])
      notify({ gitTuningFsmonitor: false })
      await runRepoPerformanceConfig(repoRecord(), 'inspect')
      expect(await localValue('core.fsmonitor')).toBeNull()
      expect(await localValue('fetch.writeCommitGraph')).toBe('true')

      changeSetting('off')
      // A read queued after the change lands behind the revert for the same repository.
      const after = await runRepoPerformanceConfig(repoRecord(), 'inspect')
      expect(after.status === 'ok' && after.state.orcaKeys).toEqual([])
      expect(await localValue('fetch.writeCommitGraph')).toBeNull()
    } finally {
      untrack()
    }
    expect(listeners).toHaveLength(0)
  })

  it('reports folder workspaces and disconnected SSH repositories as unavailable', async () => {
    await expect(
      runRepoPerformanceConfig(repoRecord({ kind: 'folder' }), 'apply')
    ).resolves.toEqual({ status: 'unavailable', reason: 'not-git' })
    await expect(
      runRepoPerformanceConfig(repoRecord({ connectionId: 'missing-target' }), 'apply')
    ).resolves.toEqual({ status: 'unavailable', reason: 'ssh-disconnected' })
    expect(await localValue('fetch.writeCommitGraph')).toBeNull()
  })

  it('runs WSL repositories under Linux rules and maps Linux paths back to UNC', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const host = createLocalGitPerformanceConfigHost(
        '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
        new GitCapabilityCache(),
        'background'
      )
      expect(host.platform).toBe('linux')
      expect(host.resolveGitPath('/home/me/repo/.git/worktrees/x/index')).toBe(
        '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\.git\\worktrees\\x\\index'
      )
    } finally {
      if (original) {
        Object.defineProperty(process, 'platform', original)
      }
    }
  })
})
