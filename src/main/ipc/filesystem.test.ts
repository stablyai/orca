import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  dirEntry,
  REPO_PATH,
  trashItemMock,
  readdirMock,
  readFileMock,
  writeFileMock,
  statMock,
  openMock,
  realpathMock,
  lstatMock,
  listWorktreesMock,
  getSshFilesystemProviderMock,
  tryDeleteWslUncPathMock,
  recordCrashBreadcrumbMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock(
  '../local-downloaded-folder-promotion',
  async () => (await import('./filesystem-test-harness')).folderPromotionMock
)
vi.mock(
  '../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../git/sequencer-actions',
  async () => (await import('./filesystem-test-harness')).gitSequencerActionsModuleMock
)
vi.mock(
  '../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock('../git/worktree', async () => (await import('./filesystem-test-harness')).gitWorktreeMock)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./filesystem-test-harness')).sshFilesystemDispatchMock
)
vi.mock(
  '../providers/ssh-git-dispatch',
  async () => (await import('./filesystem-test-harness')).sshGitDispatchMock
)
vi.mock(
  '../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { registerFilesystemHandlers } from './filesystem'
import {
  registerWorktreeRootsForRepo,
  invalidateAuthorizedRootsCache
} from './registered-worktree-roots-cache'

describe('registerFilesystemHandlers', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    // Reset module-level auth cache so each test starts with a fresh dirty
    // flag — prevents stale worktree data from a prior test's cache rebuild.
    invalidateAuthorizedRootsCache()
  })

  it('re-sorts SSH provider listings directories-first in natural order', async () => {
    // Why: the remote relay may be an older build that still sorts lexicographically.
    getSshFilesystemProviderMock.mockReturnValueOnce({
      readDir: vi.fn().mockResolvedValue([
        { name: '100 - b.txt', isDirectory: false, isSymlink: false },
        { name: '9 - c.txt', isDirectory: false, isSymlink: false },
        { name: '10 - dir', isDirectory: true, isSymlink: false },
        { name: '99 - a.txt', isDirectory: false, isSymlink: false }
      ])
    })
    registerFilesystemHandlers(store as never)

    const result = (await handlers.get('fs:readDir')!(null, {
      dirPath: '/remote/repo',
      connectionId: 'ssh-1'
    })) as { name: string }[]
    expect(result.map((e) => e.name)).toEqual([
      '10 - dir',
      '9 - c.txt',
      '99 - a.txt',
      '100 - b.txt'
    ])
  })

  it('returns an actionable reconnect error when the SSH filesystem provider is unavailable', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readDir')!(null, { dirPath: '/remote/repo', connectionId: 'ssh-1' })
    ).rejects.toThrow(
      'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
    )
  })

  // Why: handler-level WSL UNC authorization depends on native Windows path
  // resolution; path-shape classification has separate cross-platform coverage.
  it.runIf(process.platform === 'win32')(
    'records a redacted breadcrumb when fs:readDir throws on a WSL UNC path',
    async () => {
      registerFilesystemHandlers(store as never)
      const wslPath = path.win32.join('\\\\wsl.localhost\\Ubuntu', 'home', 'user', 'repo')
      // resolveAuthorizedPath authorizes the path, then readdir fails (distro stopped).
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
      // The raw path must never appear in the breadcrumb payload.
      const [, breadcrumbData] = recordCrashBreadcrumbMock.mock.calls[0]
      expect(JSON.stringify(breadcrumbData)).not.toContain('user')
    }
  )

  it('records a breadcrumb tagged ssh-provider when the SSH provider is gone', async () => {
    registerFilesystemHandlers(store as never)
    getSshFilesystemProviderMock.mockReturnValue(undefined)

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

  it('returns false from pathExists when a local authorized path is missing', async () => {
    const targetPath = path.join(REPO_PATH, 'untitled-7.md')
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))

    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:pathExists')!(null, { filePath: targetPath })).resolves.toBe(
      false
    )

    expect(statMock).toHaveBeenCalledWith(targetPath)
  })

  it('returns false from pathExists when an SSH provider reports a missing path', async () => {
    const provider = {
      stat: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:pathExists')!(null, {
        filePath: '/remote/repo/untitled-7.md',
        connectionId: 'ssh-1'
      })
    ).resolves.toBe(false)

    expect(provider.stat).toHaveBeenCalledWith('/remote/repo/untitled-7.md')
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

  it('does not enumerate worktrees when filesystem handlers register', () => {
    registerFilesystemHandlers(store as never)

    expect(listWorktreesMock).not.toHaveBeenCalled()
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
    statMock.mockResolvedValue({ size: buf.length, isDirectory: () => false, mtimeMs: 123 })
    readFileMock.mockResolvedValue(buf)
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
    statMock.mockResolvedValue({ size: content.length, isDirectory: () => false, mtimeMs: 123 })
    readFileMock.mockResolvedValue(Buffer.from(content))

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
    const close = vi.fn()
    openMock.mockResolvedValue({
      stat: vi.fn().mockResolvedValue({
        size: content.byteLength,
        dev: 1,
        ino: 2,
        birthtimeMs: 3
      }),
      readFile: vi.fn().mockResolvedValue(content),
      close
    })
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
    expect(close).toHaveBeenCalledTimes(1)
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('rejects text files beyond the editor read budget', async () => {
    statMock.mockResolvedValue({ size: 51 * 1024 * 1024, isDirectory: () => false, mtimeMs: 123 })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.resolve('/workspace/repo/huge.json') })
    ).rejects.toThrow('exceeds 50MB limit')

    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('probes large unknown binaries without reading the full file', async () => {
    statMock.mockResolvedValue({ size: 6 * 1024 * 1024, isDirectory: () => false, mtimeMs: 123 })
    openMock.mockResolvedValue({
      read: vi.fn(async (buffer: Buffer) => {
        buffer[0] = 0x00
        return { bytesRead: 1, buffer }
      }),
      close: vi.fn()
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.resolve('/workspace/repo/archive.bin') })
    ).resolves.toEqual({
      content: '',
      isBinary: true
    })

    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('moves files to trash', async () => {
    registerFilesystemHandlers(store as never)
    const targetPath = path.resolve('/workspace/repo/file.txt')

    await handlers.get('fs:deletePath')!(null, { targetPath })

    expect(trashItemMock).toHaveBeenCalledWith(targetPath)
    expect(tryDeleteWslUncPathMock).toHaveBeenCalledWith(targetPath, { recursive: undefined })
  })

  // Regression for #6415: WSL UNC paths have no Recycle Bin, so shell.trashItem
  // throws. The handler must hard-delete via the distro instead of surfacing an
  // error popup.
  it('hard-deletes a WSL UNC path instead of trashing it', async () => {
    // Why: build the UNC-style root with path.join so it resolves as a real
    // parent/child pair under the host's path semantics. A literal
    // '\\wsl.localhost\...' string only resolves correctly under win32 path
    // rules — on the Linux CI runner POSIX treats the backslashes as filename
    // characters, so the target would not be a descendant of the root and auth
    // would deny it before the WSL hard-delete ran (the real production path is
    // Windows-only).
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
    // Critical: we must NOT call trashItem for WSL UNC paths — that is exactly
    // the call that throws and produced the user-facing error.
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('propagates a WSL hard-delete failure instead of swallowing it', async () => {
    // Why: see sibling test — path.join keeps the UNC root/target a real
    // parent/child pair under both win32 and POSIX (Linux CI) path semantics.
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
    statMock.mockResolvedValue({ size: 4, isDirectory: () => false, mtimeMs: 123 })
    readFileMock.mockResolvedValue(Buffer.from([0x00, 0x01, 0x02]))

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.resolve('/workspace/repo/archive.zip') })
    ).resolves.toEqual({
      content: '',
      isBinary: true
    })
  })

  // Why: the original SSH Quick Open bug had two halves — relay-side policy
  // drift AND the main dispatcher silently dropping excludePaths before the
  // provider saw them. This test guards the second half: regardless of
  // relay behavior, a new linked worktree under the root must be forwarded
  // so the remote scan can prune it. See docs/design/share-quick-open-file-listing.md.
  it('fs:listFiles forwards excludePaths to the SSH filesystem provider', async () => {
    const listFilesMock = vi.fn().mockResolvedValue([])
    getSshFilesystemProviderMock.mockReturnValue({ listFiles: listFilesMock })

    registerFilesystemHandlers(store as never)

    await handlers.get('fs:listFiles')!(null, {
      rootPath: '/home/user/repo',
      connectionId: 'conn-1',
      excludePaths: ['/home/user/repo/worktrees/feature']
    })

    expect(listFilesMock).toHaveBeenCalledWith('/home/user/repo', {
      excludePaths: ['/home/user/repo/worktrees/feature']
    })
  })

  it('fs:listFiles forwards bounded Quick Open search options to SSH', async () => {
    const listFilesMock = vi.fn().mockResolvedValue(['src/target.ts'])
    getSshFilesystemProviderMock.mockReturnValue({ listFiles: listFilesMock })

    registerFilesystemHandlers(store as never)

    await handlers.get('fs:listFiles')!(null, {
      rootPath: '/home/user/repo',
      connectionId: 'conn-1',
      maxResults: 33,
      searchQuery: 'target'
    })

    expect(listFilesMock).toHaveBeenCalledWith('/home/user/repo', {
      excludePaths: undefined,
      maxResults: 33,
      searchQuery: 'target'
    })
  })

  it('ranks a bounded legacy SSH listing when the relay lacks Quick Open search', async () => {
    const listFilesMock = vi.fn().mockResolvedValue(['src/target.ts', 'src/index.ts'])
    const supportsQuickOpenSearchMock = vi.fn().mockResolvedValue(false)
    getSshFilesystemProviderMock.mockReturnValue({
      listFiles: listFilesMock,
      supportsQuickOpenSearch: supportsQuickOpenSearchMock
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listFiles')!(null, {
        rootPath: '/home/user/repo',
        connectionId: 'conn-1',
        maxResults: 2,
        searchQuery: 'target'
      })
    ).resolves.toEqual(['src/target.ts'])

    expect(supportsQuickOpenSearchMock).toHaveBeenCalled()
    expect(listFilesMock).toHaveBeenCalledWith('/home/user/repo', {
      excludePaths: undefined,
      maxResults: 33
    })
  })

  // Why #7721: without a cancel path, every workspace switch left the previous
  // workspace's full-tree SSH scan running, stacking scans on the relay until
  // interactive fs.readDir/fs.stat starved past their 30s timeout.
  it('fs:cancelListFiles aborts an in-flight SSH listing by request token (#7721)', async () => {
    let capturedSignal: AbortSignal | undefined
    const listFilesMock = vi.fn(
      (_rootPath: string, options: { signal?: AbortSignal }) =>
        new Promise<string[]>((_resolve, reject) => {
          capturedSignal = options.signal
          options.signal?.addEventListener('abort', () => reject(new Error('listing cancelled')), {
            once: true
          })
        })
    )
    getSshFilesystemProviderMock.mockReturnValue({ listFiles: listFilesMock })

    registerFilesystemHandlers(store as never)

    // Why: cancellation keys are scoped to the issuing webContents, so the
    // cancel must come from the same sender as the listing request.
    const senderEvent = { sender: { id: 7 } }
    const pending = handlers.get('fs:listFiles')!(senderEvent, {
      rootPath: '/home/user/repo',
      connectionId: 'conn-1',
      requestToken: 'token-1'
    }) as Promise<string[]>

    expect(capturedSignal?.aborted).toBe(false)
    await handlers.get('fs:cancelListFiles')!(senderEvent, { requestToken: 'token-1' })
    expect(capturedSignal?.aborted).toBe(true)
    await expect(pending).rejects.toThrow('listing cancelled')

    // Unknown or already-settled tokens are a no-op, not an error.
    expect(() =>
      handlers.get('fs:cancelListFiles')!(senderEvent, { requestToken: 'unknown' })
    ).not.toThrow()
  })
})
