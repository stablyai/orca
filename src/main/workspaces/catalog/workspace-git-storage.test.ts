import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAsWslLaunchUserAct } from '../../wsl/discovery/wsl-background-exec-gate'
import type * as DistroGate from '../../wsl/discovery/wsl-background-distro-gate'
import type { Repo } from '../../../shared/repo-types'

const { query, provider, running } = vi.hoisted(() => ({
  query: vi.fn(),
  provider: vi.fn(),
  running: vi.fn()
}))
vi.mock('../../wsl/discovery/wsl-background-distro-gate', async (original) => ({
  ...(await original<typeof DistroGate>()),
  readWslDistroRunningState: running
}))
const originalPlatform = process.platform
vi.mock('../../providers/execution-host-provider-dispatch', () => ({
  resolveGitRouteForHost: () => ({ kind: 'local', createProvider: provider })
}))
vi.mock('../../ssh/targets/ssh-target-registry', () => ({ getSshConnectionManager: () => null }))
vi.mock('../../ssh/remote-exec/remote-exec-command', () => ({ execCommand: vi.fn() }))
const { workspaceRootIsBare } = await import('./workspace-git-storage')
const run = promisify(execFile)
let root: string | undefined

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  vi.clearAllMocks()
})

async function layout() {
  root = await mkdtemp(join(tmpdir(), 'orca-bare-workspace-'))
  const bare = join(root, '.bare')
  execFileSync('git', ['init', '--bare', '--quiet', bare])
  await writeFile(join(root, '.git'), 'gitdir: .bare\n')
  const repo: Repo = { id: 'r', path: root, displayName: 'r', badgeColor: 'blue', addedAt: 1 }
  query.mockImplementation((args: string[], cwd: string) => run('git', args, { cwd }))
  provider.mockReturnValue({ exec: query })
  return { repo, bare }
}

describe('workspace Git storage authority', () => {
  it('recognizes both the bare store and its marker root without guessing from folder names', async () => {
    const { repo, bare } = await layout()
    expect(await workspaceRootIsBare(repo, repo.path)).toBe(true)
    expect(await workspaceRootIsBare(repo, bare)).toBe(true)
    execFileSync('git', ['init', '--quiet', join(repo.path, 'checkout')])
    expect(await workspaceRootIsBare(repo, join(repo.path, 'checkout'))).toBe(false)
    expect(await workspaceRootIsBare(repo, join(repo.path, 'gone'))).toBe(false)
    expect(await workspaceRootIsBare({ ...repo, kind: 'folder' }, repo.path)).toBe(false)
  })

  it('uses checkout graph proof but confirms bare roots before refusing', async () => {
    const { repo, bare } = await layout()
    const worktrees = [
      { path: bare, head: '', branch: '', isBare: true, isMainWorktree: true },
      { path: '/checkout', head: 'abc', branch: '', isBare: false, isMainWorktree: false }
    ]
    expect(await workspaceRootIsBare(repo, bare, { worktrees })).toBe(true)
    expect(await workspaceRootIsBare(repo, '/checkout', { worktrees })).toBe(false)
    expect(query).toHaveBeenCalledTimes(1)
    await rm(bare, { recursive: true })
    execFileSync('git', ['init', '--quiet', bare])
    expect(await workspaceRootIsBare(repo, bare, { worktrees })).toBe(false)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('joins cold-start root probes and releases them after settlement, keeping runtimes separate', async () => {
    const { repo } = await layout()
    for (const panes of [100, 1000]) {
      query.mockClear()
      expect(
        await Promise.all(Array.from({ length: panes }, () => workspaceRootIsBare(repo, repo.path)))
      ).toEqual(Array(panes).fill(true))
      expect(query).toHaveBeenCalledTimes(1)
    }
    query.mockClear()
    await Promise.all([
      workspaceRootIsBare(repo, repo.path, { wslDistro: 'Ubuntu' }),
      workspaceRootIsBare(repo, repo.path, { wslDistro: 'Debian' })
    ])
    expect(query).toHaveBeenCalledTimes(2)
    expect(provider).toHaveBeenCalledWith({ wslDistro: 'Ubuntu' })
    expect(provider).toHaveBeenCalledWith({ wslDistro: 'Debian' })
  })
})

it('classifies a stopped WSL UNC root for a user act without waking it for passive restore', async () => {
  const { repo } = await layout()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  running.mockResolvedValue('stopped')
  const cwd = '\\\\wsl.localhost\\Ubuntu\\home\\u\\project'
  query.mockResolvedValue({ stdout: 'true' })
  const userStart = () =>
    runAsWslLaunchUserAct({ isWsl: true, passiveRestore: false, distro: 'Ubuntu' }, () =>
      workspaceRootIsBare(repo, cwd, { wslDistro: 'Ubuntu' })
    )
  expect(await workspaceRootIsBare(repo, cwd, { wslDistro: 'Ubuntu' })).toBe(false)
  expect(query).not.toHaveBeenCalled()
  expect(await userStart()).toBe(true)
  query.mockResolvedValue({ stdout: 'false' })
  expect(await userStart()).toBe(false)
  query.mockRejectedValueOnce(new Error('temporarily unavailable'))
  expect(await userStart()).toBe(false)
  query.mockResolvedValue({ stdout: 'true' })
  expect(await userStart()).toBe(true)
})
