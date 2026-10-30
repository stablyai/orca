import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TRASH_DELETE_FAILED_MESSAGE } from '../../../shared/trash-delete-failure'
import {
  handlers,
  store,
  dirEntry,
  REPO_PATH,
  trashItemMock,
  rmMock,
  readdirMock,
  readFileMock,
  writeFileMock,
  statMock,
  openMock,
  realpathMock,
  lstatMock,
  listWorktreesMock,
  tryDeleteWslUncPathMock,
  recordCrashBreadcrumbMock,
  resetFilesystemIpcMocks,
  localFileHandleMock
} from './filesystem-test-harness'

const diskPreconditionMock = vi.hoisted(() => ({ writeLocalTextFileWithDiskPrecondition: vi.fn() }))
vi.mock('./local-disk-write-precondition', () => diskPreconditionMock)
vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
// The distro these UNC fixtures name counts as running, so the boot gate lets the touch through.
vi.mock('../../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: async () => 'running'
}))
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock('node:fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../../wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock(
  '../../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock(
  '../../git/worktree',
  async () => (await import('./filesystem-test-harness')).gitWorktreeMock
)
vi.mock(
  '../../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { registerFilesystemHandlers } from './filesystem'
import {
  registerWorktreeRootsForRepo,
  invalidateAuthorizedRootsCache
} from '../registered-worktree-roots-cache'

describe('registerFilesystemHandlers', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    // Drop cached roots between fixtures.
    invalidateAuthorizedRootsCache()
  })

  it('registers no channel that remembers a path grant', () => {
    registerFilesystemHandlers(store as never)

    expect(handlers.has('fs:readFile')).toBe(true)
    expect(handlers.has('fs:authorizeExternalPath')).toBe(false)
  })

  it('returns an actionable reconnect error when the SSH filesystem provider is unavailable', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readDir')!(null, {
        dirPath: '/remote/repo',
        connectionId: 'ssh-1',
        access: { kind: 'user-directory' }
      })
    ).rejects.toThrow(
      'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
    )
  })

  it('lists a user-chosen local directory outside project roots', async () => {
    const outside = path.resolve('/outside')
    statMock.mockResolvedValue({
      size: 0,
      isDirectory: () => true,
      mtimeMs: 123
    })
    readdirMock.mockResolvedValue([dirEntry({ name: 'notes.txt', file: true })])
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readDir')!(null, {
        dirPath: outside,
        access: { kind: 'user-directory' }
      })
    ).resolves.toEqual([{ name: 'notes.txt', isDirectory: false, isSymlink: false }])
  })

  // Handler UNC authorization needs native Windows resolution; shape tests run cross-platform.
  it.runIf(process.platform === 'win32')(
    'records a redacted breadcrumb when fs:readDir throws on a WSL UNC path',
    async () => {
      registerFilesystemHandlers(store as never)
      const wslPath = path.win32.join('\\\\wsl.localhost\\Ubuntu', 'home', 'user', 'repo')
      realpathMock.mockResolvedValue(wslPath)
      registerWorktreeRootsForRepo(store as never, 'repo-1', [wslPath])
      readdirMock.mockRejectedValue(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }))

      await expect(handlers.get('fs:readDir')!(null, { dirPath: wslPath })).rejects.toThrow(/EIO/)

      expect(recordCrashBreadcrumbMock).toHaveBeenCalledWith('fs_readdir_error', {
        throwSite: 'readdir',
        errorName: 'Error',
        errorCode: 'EIO',
        hasConnectionId: false,
        isUNC: true,
        isWsl: true
      })
      const [, breadcrumbData] = recordCrashBreadcrumbMock.mock.calls[0]
      expect(JSON.stringify(breadcrumbData)).not.toContain('user')
    }
  )

  it('records a breadcrumb tagged ssh-provider when the SSH provider is gone', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readDir')!(null, { dirPath: '/remote/repo', connectionId: 'ssh-1' })
    ).rejects.toThrow()

    expect(recordCrashBreadcrumbMock).toHaveBeenCalledWith(
      'fs_readdir_error',
      expect.objectContaining({ throwSite: 'ssh-provider', hasConnectionId: true })
    )
  })

  it('records a breadcrumb tagged authorize when the path is denied', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readDir')!(null, { dirPath: path.resolve('/etc/passwd') })
    ).rejects.toThrow()

    expect(recordCrashBreadcrumbMock).toHaveBeenCalledWith(
      'fs_readdir_error',
      expect.objectContaining({ throwSite: 'authorize', hasConnectionId: false })
    )
  })

  it('does not record a breadcrumb when fs:readDir succeeds', async () => {
    registerFilesystemHandlers(store as never)
    readdirMock.mockResolvedValue([dirEntry({ name: 'file.ts', file: true })])

    await handlers.get('fs:readDir')!(null, { dirPath: REPO_PATH })

    expect(recordCrashBreadcrumbMock).not.toHaveBeenCalled()
  })

  it('rejects readFile when the real path escapes allowed roots', async () => {
    const linkPath = path.resolve('/workspace/repo/link.txt')
    realpathMock.mockImplementation(async (targetPath: string) => {
      if (targetPath === linkPath) {
        return path.resolve('/private/secret.txt')
      }
      return targetPath
    })

    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:readFile')!(null, { filePath: linkPath })).rejects.toThrow(
      'Access denied: path resolves outside allowed directories'
    )

    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('allows readDir when a registered worktree resolves to a macOS canonical alias', async () => {
    const aliasWorktreePath = path.resolve('/var/folders/orca/worktrees/feature')
    const canonicalWorktreePath = path.resolve('/private/var/folders/orca/worktrees/feature')
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, aliasWorktreePath])
    realpathMock.mockImplementation(async (targetPath: string) => {
      if (targetPath === aliasWorktreePath) {
        return canonicalWorktreePath
      }
      return targetPath
    })
    readdirMock.mockResolvedValue([dirEntry({ name: 'README.md', file: true })])

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readDir')!(null, { dirPath: aliasWorktreePath })
    ).resolves.toEqual([{ name: 'README.md', isDirectory: false, isSymlink: false }])

    expect(readdirMock).toHaveBeenCalledWith(canonicalWorktreePath, { withFileTypes: true })
    expect(listWorktreesMock).not.toHaveBeenCalled()
  })

  it('does not follow symlinks when classifying readDir entries', async () => {
    const modelLinkPath = path.join(REPO_PATH, 'Model')
    readdirMock.mockResolvedValue([
      dirEntry({ name: 'README.md', file: true }),
      dirEntry({ name: 'Model', directory: true, symlink: true })
    ])
    statMock.mockImplementation(async (targetPath: string) => ({
      size: 10,
      isDirectory: () => targetPath === modelLinkPath,
      mtimeMs: 123
    }))

    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:readDir')!(null, { dirPath: REPO_PATH })).resolves.toEqual([
      { name: 'Model', isDirectory: false, isSymlink: true },
      { name: 'README.md', isDirectory: false, isSymlink: false }
    ])
    expect(statMock).not.toHaveBeenCalledWith(modelLinkPath)
  })

  it('authorizes opted-in links through the workspace spelling when its root is canonicalized', async () => {
    const canonicalRoot = path.resolve('/private/canonical-fixture')
    const linkPath = path.join(REPO_PATH, 'linked')
    realpathMock.mockImplementation(async (targetPath: string) =>
      targetPath === REPO_PATH ? canonicalRoot : targetPath
    )
    readdirMock.mockResolvedValue([dirEntry({ name: 'linked', symlink: true })])
    statMock.mockResolvedValue({ isDirectory: () => true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing IPC harness supplies every store method these handlers read.
    registerFilesystemHandlers(store as never)
    await expect(
      handlers.get('fs:readDir')!(null, {
        dirPath: REPO_PATH,
        followSymlinks: true
      })
    ).resolves.toEqual([{ name: 'linked', isDirectory: true, isSymlink: true }])
    expect(readdirMock).toHaveBeenCalledWith(canonicalRoot, { withFileTypes: true })
    expect(statMock).toHaveBeenCalledWith(linkPath)
  })

  it('returns false from pathExists when a local authorized path is missing', async () => {
    const targetPath = path.join(REPO_PATH, 'untitled-7.md')
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))

    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:pathExists')!(null, { filePath: targetPath })).resolves.toBe(
      false
    )

    expect(statMock).toHaveBeenCalledWith(targetPath)
    realpathMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await expect(
      handlers.get('fs:pathExists')!(null, {
        filePath: path.resolve('/state/agent-session-attachments/upload/gone.png'),
        access: { kind: 'chat-image' }
      })
    ).resolves.toBe(false)
  })

  it('allows deletePath when a registered worktree parent resolves to a macOS canonical alias', async () => {
    const aliasWorktreePath = path.resolve('/var/folders/orca/worktrees/feature')
    const canonicalWorktreePath = path.resolve('/private/var/folders/orca/worktrees/feature')
    const aliasFilePath = path.join(aliasWorktreePath, 'README.md')
    const canonicalFilePath = path.join(canonicalWorktreePath, 'README.md')
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, aliasWorktreePath])
    realpathMock.mockImplementation(async (targetPath: string) => {
      if (targetPath === aliasWorktreePath) {
        return canonicalWorktreePath
      }
      return targetPath
    })

    registerFilesystemHandlers(store as never)

    await handlers.get('fs:deletePath')!(null, { targetPath: aliasFilePath })

    expect(trashItemMock).toHaveBeenCalledWith(canonicalFilePath)
    expect(listWorktreesMock).not.toHaveBeenCalled()
  })

  it('rejects readFile when a symlink in a canonical alias worktree escapes the registered root', async () => {
    const aliasWorktreePath = path.resolve('/var/folders/orca/worktrees/feature')
    const canonicalWorktreePath = path.resolve('/private/var/folders/orca/worktrees/feature')
    const aliasLinkPath = path.join(aliasWorktreePath, 'link.txt')
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, aliasWorktreePath])
    realpathMock.mockImplementation(async (targetPath: string) => {
      if (targetPath === aliasWorktreePath) {
        return canonicalWorktreePath
      }
      if (targetPath === aliasLinkPath) {
        return path.resolve('/private/secret.txt')
      }
      return targetPath
    })

    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:readFile')!(null, { filePath: aliasLinkPath })).rejects.toThrow(
      'Access denied: path resolves outside allowed directories'
    )

    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('rejects writes to directories', async () => {
    lstatMock.mockResolvedValue({ isDirectory: () => true })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:writeFile')!(null, {
        filePath: path.resolve('/workspace/repo/folder'),
        content: 'data'
      })
    ).rejects.toThrow('Cannot write to a directory')

    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('routes a guarded save through the shared compare-and-write and returns its refusal', async () => {
    lstatMock.mockResolvedValue({ isDirectory: () => false })
    diskPreconditionMock.writeLocalTextFileWithDiskPrecondition.mockResolvedValueOnce({
      ok: false,
      diskConflict: 'changed'
    })
    registerFilesystemHandlers(store as never)
    const diskPrecondition = { expectedSignature: 'a-b-1' }

    await expect(
      handlers.get('fs:writeFile')!(null, {
        filePath: path.resolve('/workspace/repo/file.txt'),
        content: 'data',
        diskPrecondition
      })
    ).resolves.toEqual({ ok: false, diskConflict: 'changed' })

    expect(diskPreconditionMock.writeLocalTextFileWithDiskPrecondition).toHaveBeenCalledWith(
      path.resolve('/workspace/repo/file.txt'),
      'data',
      diskPrecondition
    )
  })

  it.each([
    ['fs:writeFile', { filePath: path.resolve('/workspace/repo/file.txt'), content: 'data' }],
    ['fs:deletePath', { targetPath: path.resolve('/workspace/repo/file.txt') }]
  ])(
    'rejects %s before local mutation when the expected execution host is SSH',
    async (channel, args) => {
      registerFilesystemHandlers(store as never)

      await expect(
        handlers.get(channel)!(null, { ...args, expectedExecutionHostId: 'ssh:ssh-1' })
      ).rejects.toThrow('Workspace host changed; refresh and try again')

      expect(writeFileMock).not.toHaveBeenCalled()
      expect(trashItemMock).not.toHaveBeenCalled()
      expect(tryDeleteWslUncPathMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    { ext: 'png', mime: 'image/png', data: [0x89, 0x50, 0x4e, 0x47, 0x00] },
    { ext: 'pdf', mime: 'application/pdf', data: [0x25, 0x50, 0x44, 0x46, 0x00] },
    {
      ext: 'svg',
      mime: 'image/svg+xml',
      data: Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />'))
    }
  ])('returns base64 content for supported $ext binaries', async ({ ext, mime, data }) => {
    const buf = Buffer.from(data)
    openMock.mockResolvedValue(localFileHandleMock(buf))
    registerFilesystemHandlers(store as never)
    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.resolve(`/workspace/repo/file.${ext}`) })
    ).resolves.toEqual({
      content: buf.toString('base64'),
      isBinary: true,
      isImage: true,
      mimeType: mime
    })
  })

  it('opens text files larger than the old 5MB guard', async () => {
    const content = 'a'.repeat(6 * 1024 * 1024)
    openMock.mockResolvedValue(localFileHandleMock(Buffer.from(content)))

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.resolve('/workspace/repo/large.json') })
    ).resolves.toEqual({
      content,
      isBinary: false
    })
  })

  it('returns stable byte metadata only for opted-in local log snapshots', async () => {
    const content = Buffer.from('first\npartial')
    const handle = localFileHandleMock(content)
    openMock.mockResolvedValue(handle)
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, {
        filePath: path.resolve('/workspace/repo/session.jsonl'),
        includeLocalLogMetadata: true
      })
    ).resolves.toEqual({
      content: 'first\npartial',
      isBinary: false,
      fileIdentity: '1:2:3'
    })
    expect(handle.close).toHaveBeenCalledTimes(1)
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('rejects text files beyond the editor read budget', async () => {
    const handle = localFileHandleMock(Buffer.alloc(0), { size: 51 * 1024 * 1024 })
    openMock.mockResolvedValue(handle)

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.resolve('/workspace/repo/huge.json') })
    ).rejects.toThrow('exceeds 50MB limit')

    expect(handle.read).not.toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalled()
  })

  it('probes large unknown binaries without reading the full file', async () => {
    const handle = localFileHandleMock(Buffer.alloc(6 * 1024 * 1024))
    openMock.mockResolvedValue(handle)

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.resolve('/workspace/repo/archive.bin') })
    ).resolves.toEqual({
      content: '',
      isBinary: true
    })

    expect(handle.read).toHaveBeenCalledTimes(1)
  })

  it('moves files to trash', async () => {
    registerFilesystemHandlers(store as never)
    const targetPath = path.resolve('/workspace/repo/file.txt')

    await handlers.get('fs:deletePath')!(null, { targetPath })

    expect(trashItemMock).toHaveBeenCalledWith(targetPath)
    expect(tryDeleteWslUncPathMock).toHaveBeenCalledWith(targetPath, { recursive: undefined })
  })

  it('tags a Trash failure so the renderer can offer permanent deletion', async () => {
    // SAFETY: the fixture supplies the store methods used by filesystem authorization.
    registerFilesystemHandlers(store as never)
    const targetPath = path.resolve('/workspace/repo/file.txt')
    trashItemMock.mockRejectedValue(new Error('Failed to perform delete operation'))

    await expect(handlers.get('fs:deletePath')!(null, { targetPath })).rejects.toThrow(
      `${TRASH_DELETE_FAILED_MESSAGE}: Failed to perform delete operation`
    )
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('hard-deletes without Trash only when permanent is exactly true', async () => {
    // SAFETY: the fixture supplies the store methods used by filesystem authorization.
    registerFilesystemHandlers(store as never)
    const targetPath = path.resolve('/workspace/repo/dir')

    await handlers.get('fs:deletePath')!(null, { targetPath, recursive: true, permanent: 'yes' })
    expect(rmMock).not.toHaveBeenCalled()
    expect(trashItemMock).toHaveBeenCalledWith(targetPath)

    trashItemMock.mockClear()
    await handlers.get('fs:deletePath')!(null, { targetPath, recursive: true, permanent: true })
    expect(rmMock).toHaveBeenCalledWith(targetPath, { recursive: true, force: true })
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('authorizes a permanent retry and propagates filesystem failures without a Trash tag', async () => {
    // SAFETY: the fixture supplies the store methods used by filesystem authorization.
    registerFilesystemHandlers(store as never)
    const targetPath = path.resolve('/workspace/repo/file.txt')

    await expect(
      handlers.get('fs:deletePath')!(null, {
        targetPath: path.resolve('/outside-workspace/file.txt'),
        permanent: true
      })
    ).rejects.toThrow('Access denied')
    expect(rmMock).not.toHaveBeenCalled()
    expect(trashItemMock).not.toHaveBeenCalled()

    rmMock.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    await expect(
      handlers.get('fs:deletePath')!(null, { targetPath, permanent: true })
    ).rejects.toThrow('EACCES: permission denied')
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('does not offer a permanent retry when the trashed item is already missing', async () => {
    // SAFETY: the fixture supplies the store methods used by filesystem authorization.
    registerFilesystemHandlers(store as never)
    trashItemMock.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))

    await expect(
      handlers.get('fs:deletePath')!(null, { targetPath: path.resolve('/workspace/repo/file.txt') })
    ).resolves.toBeUndefined()
    expect(rmMock).not.toHaveBeenCalled()
  })

  // WSL UNC has no Recycle Bin; delete inside the distro instead (#6415).
  it('hard-deletes a WSL UNC path instead of trashing it', async () => {
    // Build with host path semantics so root/child containment also holds on POSIX CI.
    const wslUncRoot = path.join(
      `${path.sep}${path.sep}wsl.localhost`,
      'Ubuntu',
      'home',
      'me',
      'repo'
    )
    const targetPath = path.join(wslUncRoot, 'file.txt')
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, wslUncRoot])
    tryDeleteWslUncPathMock.mockResolvedValue(true)

    registerFilesystemHandlers(store as never)

    await handlers.get('fs:deletePath')!(null, { targetPath, recursive: true })

    expect(tryDeleteWslUncPathMock).toHaveBeenCalledWith(targetPath, { recursive: true })
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('propagates a WSL hard-delete failure instead of swallowing it', async () => {
    // Build a host-valid root/child pair as in the sibling test.
    const wslUncRoot = path.join(
      `${path.sep}${path.sep}wsl.localhost`,
      'Ubuntu',
      'home',
      'me',
      'repo'
    )
    const targetPath = path.join(wslUncRoot, 'file.txt')
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, wslUncRoot])
    tryDeleteWslUncPathMock.mockRejectedValue(
      new Error('Failed to delete WSL path: Permission denied')
    )

    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:deletePath')!(null, { targetPath })).rejects.toThrow(
      'Failed to delete WSL path: Permission denied'
    )
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('keeps non-image binaries hidden from the editor payload', async () => {
    openMock.mockResolvedValue(localFileHandleMock(Buffer.from([0x00, 0x01, 0x02])))

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.resolve('/workspace/repo/archive.zip') })
    ).resolves.toEqual({
      content: '',
      isBinary: true
    })
  })
})
