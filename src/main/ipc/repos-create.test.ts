/**
 * Unit tests for repos:create (orca#763).
 *
 * Pins the invariants that matter here:
 *   - Name validation catches empty/slash/./.. before any fs I/O.
 *   - Empty pre-existing directories are accepted; non-empty ones are not.
 *   - Only directories we create ourselves are removed on rollback — a folder
 *     the user picked must survive a failure so they can retry.
 *   - Git repos get an empty initial commit; without it, HEAD has no branch.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

const { handleMock, mockStore, mkdirMock, accessMock, readdirMock, rmMock, gitExecFileAsyncMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    mockStore: {
      getRepos: vi.fn().mockReturnValue([]),
      addRepo: vi.fn(),
      removeRepo: vi.fn(),
      getRepo: vi.fn(),
      updateRepo: vi.fn()
    },
    mkdirMock: vi.fn(),
    accessMock: vi.fn(),
    readdirMock: vi.fn(),
    rmMock: vi.fn(),
    gitExecFileAsyncMock: vi.fn()
  }))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: handleMock,
    removeHandler: vi.fn()
  }
}))

vi.mock('fs/promises', () => ({
  mkdir: mkdirMock,
  access: accessMock,
  readdir: readdirMock,
  rm: rmMock
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitSpawn: vi.fn()
}))

vi.mock('../git/repo', () => ({
  isGitRepo: vi.fn().mockReturnValue(true),
  getGitUsername: vi.fn().mockReturnValue(''),
  getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop()),
  getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
  searchBaseRefs: vi.fn().mockResolvedValue([])
}))

vi.mock('./filesystem-auth', () => ({
  rebuildAuthorizedRootsCache: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn()
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: vi.fn()
}))

import { registerRepoHandlers } from './repos'

type CreateArgs = { parentPath: string; name: string; kind: 'git' | 'folder' }
type CreateResult = { repo: { id: string; path: string; kind: string } } | { error: string }

describe('repos:create', () => {
  const handlers = new Map<string, (event: unknown, args: CreateArgs) => Promise<CreateResult>>()
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  const callCreate = (args: CreateArgs): Promise<CreateResult> => {
    const handler = handlers.get('repos:create')
    if (!handler) {
      throw new Error('repos:create handler was never registered')
    }
    return handler(null, args)
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler as (event: unknown, args: CreateArgs) => Promise<CreateResult>)
    })
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.addRepo.mockReset()
    mockWindow.webContents.send.mockReset()

    // Default baseline: target does NOT exist yet, mkdir succeeds, git OK.
    accessMock.mockReset().mockRejectedValue(new Error('ENOENT'))
    readdirMock.mockReset().mockResolvedValue([])
    mkdirMock.mockReset().mockResolvedValue(undefined)
    rmMock.mockReset().mockResolvedValue(undefined)
    gitExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' })

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('registers the repos:create handler', () => {
    expect(handlers.has('repos:create')).toBe(true)
  })

  // ── input validation ──────────────────────────────────────────────

  it('rejects empty names', async () => {
    const result = await callCreate({ parentPath: '/tmp', name: '   ', kind: 'git' })
    expect(result).toEqual({ error: 'Name cannot be empty' })
    expect(mkdirMock).not.toHaveBeenCalled()
  })

  it('rejects names containing a forward slash', async () => {
    const result = await callCreate({ parentPath: '/tmp', name: 'foo/bar', kind: 'git' })
    expect(result).toMatchObject({ error: expect.stringContaining('slash') })
    expect(mkdirMock).not.toHaveBeenCalled()
  })

  it('rejects names containing a backslash', async () => {
    const result = await callCreate({ parentPath: '/tmp', name: 'foo\\bar', kind: 'git' })
    expect(result).toMatchObject({ error: expect.stringContaining('slash') })
    expect(mkdirMock).not.toHaveBeenCalled()
  })

  it('rejects "." and ".." as names', async () => {
    for (const name of ['.', '..']) {
      mkdirMock.mockClear()
      const result = await callCreate({ parentPath: '/tmp', name, kind: 'git' })
      expect(result).toMatchObject({ error: expect.stringContaining('slash') })
      expect(mkdirMock).not.toHaveBeenCalled()
    }
  })

  it('rejects empty parent path', async () => {
    const result = await callCreate({ parentPath: '   ', name: 'project', kind: 'git' })
    expect(result).toEqual({ error: 'Parent directory is required' })
    expect(mkdirMock).not.toHaveBeenCalled()
  })

  // ── existing-directory handling ───────────────────────────────────

  it('rejects a non-empty existing directory without calling mkdir', async () => {
    accessMock.mockResolvedValueOnce(undefined) // exists
    readdirMock.mockResolvedValueOnce(['README.md', '.DS_Store'])

    const result = await callCreate({ parentPath: '/tmp', name: 'busy', kind: 'git' })

    expect(result).toMatchObject({ error: expect.stringContaining('not empty') })
    expect(mkdirMock).not.toHaveBeenCalled()
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('accepts an empty existing directory and does not call mkdir', async () => {
    accessMock.mockResolvedValueOnce(undefined) // exists
    readdirMock.mockResolvedValueOnce([])

    const result = await callCreate({ parentPath: '/tmp', name: 'empty', kind: 'folder' })

    expect(mkdirMock).not.toHaveBeenCalled()
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/tmp/empty', kind: 'folder' })
    )
    expect(result).toHaveProperty('repo.kind', 'folder')
  })

  it('creates a missing directory with mkdir', async () => {
    // accessMock rejects by default → path does not exist
    await callCreate({ parentPath: '/tmp', name: 'brand-new', kind: 'folder' })

    expect(mkdirMock).toHaveBeenCalledWith('/tmp/brand-new', { recursive: false })
  })

  // ── plain folder happy path ───────────────────────────────────────

  it('creates a plain folder without running any git commands', async () => {
    const result = await callCreate({ parentPath: '/tmp', name: 'plain', kind: 'folder' })

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/tmp/plain',
        displayName: 'plain',
        kind: 'folder'
      })
    )
    expect(result).toHaveProperty('repo.kind', 'folder')
  })

  // ── git repo happy path ───────────────────────────────────────────

  it('creates a git repo with an empty initial commit (in order)', async () => {
    const result = await callCreate({ parentPath: '/tmp', name: 'gitproj', kind: 'git' })

    expect(mkdirMock).toHaveBeenCalledWith('/tmp/gitproj', { recursive: false })
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(1, ['init'], { cwd: '/tmp/gitproj' })
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['commit', '--allow-empty', '-m', 'Initial commit'],
      { cwd: '/tmp/gitproj' }
    )
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/tmp/gitproj',
        displayName: 'gitproj',
        kind: 'git'
      })
    )
    expect(result).toHaveProperty('repo.kind', 'git')
  })

  // ── rollback semantics ────────────────────────────────────────────

  it('rolls back the directory it just created when git init fails', async () => {
    gitExecFileAsyncMock.mockReset().mockRejectedValueOnce(new Error('git init blew up'))

    const result = await callCreate({ parentPath: '/tmp', name: 'broken', kind: 'git' })

    expect(rmMock).toHaveBeenCalledWith('/tmp/broken', { recursive: true, force: true })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
    expect(result).toMatchObject({ error: expect.stringContaining('Failed to initialize') })
  })

  it('does NOT rm a pre-existing empty directory when git init fails', async () => {
    // Pretend the directory already existed (and is empty) — user pre-created it.
    accessMock.mockResolvedValueOnce(undefined)
    readdirMock.mockResolvedValueOnce([])
    gitExecFileAsyncMock.mockReset().mockRejectedValueOnce(new Error('git init blew up'))

    const result = await callCreate({ parentPath: '/tmp', name: 'preexisting', kind: 'git' })

    expect(rmMock).not.toHaveBeenCalled()
    expect(mockStore.addRepo).not.toHaveBeenCalled()
    expect(result).toMatchObject({ error: expect.stringContaining('Failed to initialize') })
  })

  // ── friendly messaging ────────────────────────────────────────────

  it('surfaces a friendly message when git author identity is missing', async () => {
    gitExecFileAsyncMock
      .mockReset()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git init
      .mockRejectedValueOnce(
        new Error('Please tell me who you are. Run git config --global user.email ...')
      )

    const result = await callCreate({ parentPath: '/tmp', name: 'authorless', kind: 'git' })

    expect(rmMock).toHaveBeenCalledWith('/tmp/authorless', { recursive: true, force: true })
    expect(result).toMatchObject({
      error: expect.stringContaining('Git author identity is not configured')
    })
  })

  // ── renderer notification ─────────────────────────────────────────

  it('notifies the renderer via repos:changed after a successful create', async () => {
    await callCreate({ parentPath: '/tmp', name: 'notified', kind: 'folder' })
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
  })
})
