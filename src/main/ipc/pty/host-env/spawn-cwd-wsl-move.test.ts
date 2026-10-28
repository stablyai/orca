import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveCutoverFixture as cutover } from '../../../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  WslMoveProjectFencedError,
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { assertWorkspaceAcceptsNewPty, localPtySpawnCwd } from './spawn-cwd'

const { listLiveDaemonPtyIds } = vi.hoisted(() => ({
  listLiveDaemonPtyIds: vi.fn<() => Promise<string[] | null>>()
}))
vi.mock('../../../daemon/daemon-provider-state', () => ({ listLiveDaemonPtyIds }))

let userDataPath: string
// No store: a readable journal never needs one.
const accept = (worktreeId: string, sessionId?: string) =>
  Promise.resolve(assertWorkspaceAcceptsNewPty(undefined, worktreeId, sessionId))
const acceptCwd = (cwd: string | undefined, worktreeId?: string, sessionId?: string) =>
  Promise.resolve(assertWorkspaceAcceptsNewPty(undefined, worktreeId, sessionId, cwd))

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-spawn-'))
  loadWslMoveFence(userDataPath)
  seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
  listLiveDaemonPtyIds.mockReset()
})
afterEach(() => {
  resetWslMoveFenceForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('assertWorkspaceAcceptsNewPty under a WSL move', () => {
  it('refuses a fresh terminal in a moving project and never asks the daemon', async () => {
    await expect(accept('repo-1::/x')).rejects.toBeInstanceOf(WslMoveProjectFencedError)
    expect(listLiveDaemonPtyIds).not.toHaveBeenCalled()
  })

  it('lets a reload reattach a session the daemon still runs', async () => {
    listLiveDaemonPtyIds.mockResolvedValue(['repo-1::/x@@1'])
    await expect(accept('repo-1::/x', 'repo-1::/x@@1')).resolves.toBeUndefined()
  })

  it.each([
    ['an exited session (a cold restore)', ['other@@2']],
    ['an unanswered census', null]
  ])('refuses %s', async (_label, live) => {
    listLiveDaemonPtyIds.mockResolvedValue(live)
    await expect(accept('repo-1::/x', 'repo-1::/x@@1')).rejects.toBeInstanceOf(
      WslMoveProjectFencedError
    )
  })

  it('leaves other projects alone', async () => {
    await expect(accept('repo-2::/x')).resolves.toBeUndefined()
  })
})

// R46: a terminal the workspace fence misses would otherwise outlive the commit in a moved folder.
describe('a spawn by its folder, between quiesce and commit', () => {
  beforeEach(() => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'blobs-transferred'))
  })

  it.each([
    ['the project root', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-1'],
    ['a folder inside it', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-1\\src'],
    [
      'the wsl$ alias, distro case and a trailing separator',
      '\\\\wsl$\\UBUNTU\\home\\dev\\repo-1\\'
    ],
    ['the Linux spelling', '/home/dev/repo-1/src']
  ])('refuses one that starts in %s', async (_label, cwd) => {
    await expect(acceptCwd(cwd)).rejects.toBeInstanceOf(WslMoveProjectFencedError)
  })

  it('lets a reload reattach a session the daemon still runs', async () => {
    listLiveDaemonPtyIds.mockResolvedValue(['bare-session'])
    await expect(acceptCwd('/home/dev/repo-1', undefined, 'bare-session')).resolves.toBeUndefined()
  })

  it.each([
    ['a sibling whose name shares the prefix', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-10'],
    ['the parent folder', '\\\\wsl.localhost\\Ubuntu\\home\\dev'],
    ['the same folder in another distro', '\\\\wsl.localhost\\Debian\\home\\dev\\repo-1'],
    ['a Windows folder', 'C:\\Users\\dev\\repo-1'],
    ['another Linux folder', '/home/dev/other'],
    ['no folder at all', undefined]
  ])('leaves one alone that starts in %s', async (_label, cwd) => {
    await expect(acceptCwd(cwd)).resolves.toBeUndefined()
    expect(listLiveDaemonPtyIds).not.toHaveBeenCalled()
  })

  it.each([
    ['a floating terminal', 'global-floating-terminal'],
    ['another project', 'repo-2::/x'],
    ['a folder workspace', 'folder:folder-9']
  ])('refuses %s that starts in a moving folder', async (_label, worktreeId) => {
    await expect(acceptCwd('/home/dev/repo-1/src', worktreeId)).rejects.toBeInstanceOf(
      WslMoveProjectFencedError
    )
  })

  it('leaves another workspace alone that starts outside the moving folders', async () => {
    await expect(acceptCwd('/home/dev/other', 'repo-2::/x')).resolves.toBeUndefined()
    await expect(acceptCwd('C:\\work', 'folder:folder-9')).resolves.toBeUndefined()
  })

  it('never reads the folder of an SSH spawn, which runs on another machine', () => {
    expect(localPtySpawnCwd({ connectionId: 'ssh-1', cwd: '/home/dev/repo-1' })).toBeUndefined()
    expect(localPtySpawnCwd({ connectionId: null, cwd: '/home/dev/repo-1' })).toBe(
      '/home/dev/repo-1'
    )
  })

  it('stops at the commit, once the host owns the folder', async () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    await expect(acceptCwd('/home/dev/repo-1')).resolves.toBeUndefined()
  })
})
