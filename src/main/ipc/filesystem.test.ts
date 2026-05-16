/* eslint-disable max-lines -- Why: filesystem authorization and git/file IPC invariants are exercised end-to-end here, so the scenarios stay together to keep the security boundary readable. */
import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>()
const {
  handleMock,
  trashItemMock,
  readdirMock,
  readFileMock,
  writeFileMock,
  statMock,
  openMock,
  realpathMock,
  lstatMock,
  commitChangesMock,
  getStatusMock,
  getDiffMock,
  getBranchCompareMock,
  getBranchDiffMock,
  getStagedCommitContextMock,
  stageFileMock,
  bulkStageFilesMock,
  unstageFileMock,
  bulkUnstageFilesMock,
  bulkDiscardChangesMock,
  discardChangesMock,
  listWorktreesMock,
  resolveCommitMessageSettingsMock,
  generateCommitMessageFromContextMock,
  cancelGenerateCommitMessageLocalMock,
  getSshFilesystemProviderMock,
  getSshGitProviderMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  trashItemMock: vi.fn(),
  readdirMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
  statMock: vi.fn(),
  openMock: vi.fn(),
  realpathMock: vi.fn(),
  lstatMock: vi.fn(),
  commitChangesMock: vi.fn(),
  getStatusMock: vi.fn(),
  getDiffMock: vi.fn(),
  getBranchCompareMock: vi.fn(),
  getBranchDiffMock: vi.fn(),
  getStagedCommitContextMock: vi.fn(),
  stageFileMock: vi.fn(),
  bulkStageFilesMock: vi.fn(),
  unstageFileMock: vi.fn(),
  bulkUnstageFilesMock: vi.fn(),
  bulkDiscardChangesMock: vi.fn(),
  discardChangesMock: vi.fn(),
  listWorktreesMock: vi.fn(),
  resolveCommitMessageSettingsMock: vi.fn(),
  generateCommitMessageFromContextMock: vi.fn(),
  cancelGenerateCommitMessageLocalMock: vi.fn(),
  getSshFilesystemProviderMock: vi.fn(),
  getSshGitProviderMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  },
  shell: {
    trashItem: trashItemMock
  }
}))

vi.mock('fs/promises', () => ({
  readdir: readdirMock,
  readFile: readFileMock,
  writeFile: writeFileMock,
  stat: statMock,
  open: openMock,
  realpath: realpathMock,
  lstat: lstatMock
}))

vi.mock('../git/status', () => ({
  commitChanges: commitChangesMock,
  getStatus: getStatusMock,
  getDiff: getDiffMock,
  getBranchCompare: getBranchCompareMock,
  getBranchDiff: getBranchDiffMock,
  getStagedCommitContext: getStagedCommitContextMock,
  stageFile: stageFileMock,
  bulkStageFiles: bulkStageFilesMock,
  unstageFile: unstageFileMock,
  bulkUnstageFiles: bulkUnstageFilesMock,
  bulkDiscardChanges: bulkDiscardChangesMock,
  discardChanges: discardChangesMock
}))

vi.mock('../git/worktree', () => ({
  listWorktrees: listWorktreesMock
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

vi.mock('../text-generation/commit-message-text-generation', () => ({
  resolveCommitMessageSettings: resolveCommitMessageSettingsMock,
  generateCommitMessageFromContext: generateCommitMessageFromContextMock,
  cancelGenerateCommitMessageLocal: cancelGenerateCommitMessageLocalMock
}))

import { registerFilesystemHandlers } from './filesystem'
import { invalidateAuthorizedRootsCache, registerWorktreeRootsForRepo } from './filesystem-auth'

// Why: paths are resolved via path.resolve() in production code, so test
// data must use resolved paths to avoid Unix-vs-Windows mismatches.
const REPO_PATH = path.resolve('/workspace/repo')
const WORKSPACE_DIR = path.resolve('/workspace')
const WORKTREE_FEATURE_PATH = path.resolve('/workspace/repo-feature')

type MockDirEntry = {
  name: string
  directory?: boolean
  file?: boolean
  symlink?: boolean
}

function dirEntry({ name, directory, file, symlink }: MockDirEntry): {
  name: string
  isDirectory: () => boolean
  isFile: () => boolean
  isSymbolicLink: () => boolean
} {
  return {
    name,
    isDirectory: () => directory ?? false,
    isFile: () => file ?? false,
    isSymbolicLink: () => symlink ?? false
  }
}

describe('registerFilesystemHandlers', () => {
  const store = {
    getRepos: () => [
      {
        id: 'repo-1',
        path: REPO_PATH,
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0
      }
    ],
    getSettings: () => ({
      workspaceDir: WORKSPACE_DIR
    })
  }

  beforeEach(() => {
    handlers.clear()
    for (const mock of [
      handleMock,
      trashItemMock,
      readdirMock,
      readFileMock,
      writeFileMock,
      statMock,
      openMock,
      realpathMock,
      lstatMock,
      commitChangesMock,
      getStatusMock,
      getDiffMock,
      getBranchCompareMock,
      getBranchDiffMock,
      getStagedCommitContextMock,
      stageFileMock,
      bulkStageFilesMock,
      unstageFileMock,
      bulkUnstageFilesMock,
      bulkDiscardChangesMock,
      discardChangesMock,
      listWorktreesMock,
      resolveCommitMessageSettingsMock,
      generateCommitMessageFromContextMock,
      cancelGenerateCommitMessageLocalMock,
      getSshFilesystemProviderMock,
      getSshGitProviderMock
    ]) {
      mock.mockReset()
    }

    handleMock.mockImplementation((channel, handler) => {
      handlers.set(channel, handler)
    })

    // Reset module-level auth cache so each test starts with a fresh dirty
    // flag — prevents stale worktree data from a prior test's cache rebuild.
    invalidateAuthorizedRootsCache()

    realpathMock.mockImplementation(async (targetPath: string) => targetPath)
    listWorktreesMock.mockResolvedValue([
      {
        path: WORKTREE_FEATURE_PATH,
        head: 'abc',
        branch: '',
        isBare: false,
        isMainWorktree: false
      }
    ])
    trashItemMock.mockResolvedValue(undefined)
    getSshGitProviderMock.mockReturnValue(null)
    statMock.mockResolvedValue({ size: 10, isDirectory: () => false, mtimeMs: 123 })
    openMock.mockResolvedValue({
      read: vi.fn(async (buffer: Buffer) => {
        buffer.fill(0x61)
        return { bytesRead: buffer.length, buffer }
      }),
      close: vi.fn()
    })
    lstatMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
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

  it('reports symlinked directories from readDir as directories', async () => {
    const modelLinkPath = path.join(REPO_PATH, 'Model')
    readdirMock.mockResolvedValue([
      dirEntry({ name: 'README.md', file: true }),
      dirEntry({ name: 'Model', symlink: true })
    ])
    statMock.mockImplementation(async (targetPath: string) => ({
      size: 10,
      isDirectory: () => targetPath === modelLinkPath,
      mtimeMs: 123
    }))

    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:readDir')!(null, { dirPath: REPO_PATH })).resolves.toEqual([
      { name: 'Model', isDirectory: true, isSymlink: true },
      { name: 'README.md', isDirectory: false, isSymlink: false }
    ])
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

  it('normalizes repo worktree paths and keeps git file paths relative', async () => {
    stageFileMock.mockResolvedValue(undefined)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:stage')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      filePath: './src/../src/file.ts'
    })

    // Why: validateGitRelativeFilePath uses path.relative() which produces
    // platform-specific separators (backslashes on Windows).
    expect(stageFileMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, path.join('src', 'file.ts'))
  })

  it('uses worktree roots seeded by worktrees:list without rebuilding the cache', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    getStatusMock.mockResolvedValue({ entries: [] })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:status')!(null, { worktreePath: WORKTREE_FEATURE_PATH })

    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(realpathMock).not.toHaveBeenCalledWith(WORKTREE_FEATURE_PATH)
    expect(getStatusMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, { includeIgnored: false })
  })

  it('forwards includeIgnored through local and SSH git status IPC', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    getStatusMock.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    const sshProvider = {
      getStatus: vi.fn().mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:status')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      includeIgnored: true
    })
    await handlers.get('git:status')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'ssh-1',
      includeIgnored: true
    })

    expect(getStatusMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, { includeIgnored: true })
    expect(sshProvider.getStatus).toHaveBeenCalledWith('/remote/repo', { includeIgnored: true })
  })

  it('rejects git file paths that escape the selected worktree', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:discard')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        filePath: '../outside.txt'
      })
    ).rejects.toThrow('Access denied: git file path escapes the selected worktree')

    expect(discardChangesMock).not.toHaveBeenCalled()
  })

  it('rejects git operations for unknown worktrees', async () => {
    listWorktreesMock.mockResolvedValue([])

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:status')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).rejects.toThrow('Access denied: unknown repository or worktree path')

    expect(getStatusMock).not.toHaveBeenCalled()
  })

  it('normalizes git file paths for bulk stage requests', async () => {
    bulkStageFilesMock.mockResolvedValue(undefined)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:bulkStage')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      filePaths: ['./src/../src/file.ts', 'nested//child.ts']
    })

    expect(bulkStageFilesMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, [
      path.join('src', 'file.ts'),
      path.join('nested', 'child.ts')
    ])
  })

  it('normalizes git file paths for bulk discard requests', async () => {
    bulkDiscardChangesMock.mockResolvedValue(undefined)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:bulkDiscard')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      filePaths: ['./src/../src/file.ts', 'nested//child.ts']
    })

    expect(bulkDiscardChangesMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, [
      path.join('src', 'file.ts'),
      path.join('nested', 'child.ts')
    ])
  })

  it('rejects bulk unstage requests that escape the selected worktree', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:bulkUnstage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        filePaths: ['src/file.ts', '../outside.txt']
      })
    ).rejects.toThrow('Access denied: git file path escapes the selected worktree')

    expect(bulkUnstageFilesMock).not.toHaveBeenCalled()
  })

  it('rejects bulk discard requests that escape the selected worktree', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:bulkDiscard')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        filePaths: ['src/file.ts', '../outside.txt']
      })
    ).rejects.toThrow('Access denied: git file path escapes the selected worktree')

    expect(bulkDiscardChangesMock).not.toHaveBeenCalled()
  })

  it('lists markdown documents recursively for a registered worktree', async () => {
    readdirMock.mockImplementation(async (dirPath: string) => {
      if (dirPath === WORKTREE_FEATURE_PATH) {
        return [
          dirEntry({ name: 'README.md', file: true }),
          dirEntry({ name: 'docs', directory: true }),
          dirEntry({ name: 'script.ts', file: true })
        ]
      }
      if (dirPath === path.join(WORKTREE_FEATURE_PATH, 'docs')) {
        return [
          dirEntry({ name: 'Guide.MDX', file: true }),
          dirEntry({ name: 'notes.markdown', file: true })
        ]
      }
      return []
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual([
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, 'docs', 'Guide.MDX'),
        relativePath: 'docs/Guide.MDX',
        basename: 'Guide.MDX',
        name: 'Guide'
      },
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, 'docs', 'notes.markdown'),
        relativePath: 'docs/notes.markdown',
        basename: 'notes.markdown',
        name: 'notes'
      },
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, 'README.md'),
        relativePath: 'README.md',
        basename: 'README.md',
        name: 'README'
      }
    ])
  })

  it('skips ignored and symlinked directories when listing markdown documents', async () => {
    readdirMock.mockImplementation(async (dirPath: string) => {
      if (dirPath === WORKTREE_FEATURE_PATH) {
        return [
          dirEntry({ name: '.git', directory: true }),
          dirEntry({ name: '.hidden', directory: true }),
          dirEntry({ name: '.github', directory: true }),
          dirEntry({ name: 'node_modules', directory: true }),
          dirEntry({ name: 'linked-docs', directory: true, symlink: true }),
          dirEntry({ name: 'visible.md', file: true })
        ]
      }
      if (dirPath === path.join(WORKTREE_FEATURE_PATH, '.github')) {
        return [dirEntry({ name: 'CONTRIBUTING.md', file: true })]
      }
      throw new Error(`Unexpected readdir: ${dirPath}`)
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual([
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, '.github', 'CONTRIBUTING.md'),
        relativePath: '.github/CONTRIBUTING.md',
        basename: 'CONTRIBUTING.md',
        name: 'CONTRIBUTING'
      },
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, 'visible.md'),
        relativePath: 'visible.md',
        basename: 'visible.md',
        name: 'visible'
      }
    ])
  })

  it('rejects markdown document listing for authorized but unregistered roots', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: path.resolve('/workspace/unregistered')
      })
    ).rejects.toThrow('Access denied: unknown repository or worktree path')

    expect(readdirMock).not.toHaveBeenCalled()
  })

  it('lists remote markdown documents through the SSH filesystem provider', async () => {
    const provider = {
      listFiles: vi
        .fn()
        .mockResolvedValue(['README.md', 'docs/guide.mdx', '../outside.md', 'src/app.ts'])
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: '/home/user/project',
        connectionId: 'ssh-1'
      })
    ).resolves.toEqual([
      {
        filePath: '/home/user/project/docs/guide.mdx',
        relativePath: 'docs/guide.mdx',
        basename: 'guide.mdx',
        name: 'guide'
      },
      {
        filePath: '/home/user/project/README.md',
        relativePath: 'README.md',
        basename: 'README.md',
        name: 'README'
      }
    ])
  })

  it('routes branch compare queries through the git compare helper', async () => {
    getBranchCompareMock.mockResolvedValue({
      summary: {
        baseRef: 'origin/main',
        baseOid: 'base-oid',
        compareRef: 'main',
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid',
        changedFiles: 1,
        status: 'ready'
      },
      entries: [{ path: 'src/file.ts', status: 'modified' }]
    })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:branchCompare')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      baseRef: 'origin/main'
    })

    expect(getBranchCompareMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, 'origin/main')
  })

  it('routes local git:commit through commitChanges and returns success', async () => {
    commitChangesMock.mockResolvedValue({ success: true })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        message: 'feat: ship commit'
      })
    ).resolves.toEqual({ success: true })

    expect(commitChangesMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, 'feat: ship commit')
  })

  it('returns local commit hook failure payload from git:commit', async () => {
    commitChangesMock.mockResolvedValue({ success: false, error: 'hook failed' })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        message: 'feat: ship commit'
      })
    ).resolves.toEqual({ success: false, error: 'hook failed' })
  })

  it('generates a local commit message from main-process staged context', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Update README'
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual({ success: true, message: 'Update README' })

    expect(getStagedCommitContextMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH)
    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(context, params, {
      kind: 'local',
      cwd: WORKTREE_FEATURE_PATH
    })
  })

  it('prepares the selected Codex account home before local generation', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Update README'
    })

    registerFilesystemHandlers(store as never, {
      prepareForCodexLaunch: () => '/managed/codex-home'
    })

    await handlers.get('git:generateCommitMessage')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH
    })

    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
      context,
      params,
      expect.objectContaining({
        kind: 'local',
        cwd: WORKTREE_FEATURE_PATH,
        env: expect.objectContaining({ CODEX_HOME: '/managed/codex-home' })
      })
    )
  })

  it('preserves the inherited Codex environment when no managed account is selected', async () => {
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = '/system/codex-home'
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Update README'
    })

    try {
      registerFilesystemHandlers(store as never, {
        prepareForCodexLaunch: () => null
      })

      await handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })

      expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(context, params, {
        kind: 'local',
        cwd: WORKTREE_FEATURE_PATH
      })
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
    }
  })

  it('returns a sanitized error when local agent account preparation fails', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)

    registerFilesystemHandlers(store as never, {
      prepareForCodexLaunch: () => {
        throw new Error('failed to read /Users/alice/.codex/auth.json')
      }
    })

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual({
      success: false,
      error: 'Failed to prepare the selected agent account for commit message generation.'
    })
    expect(generateCommitMessageFromContextMock).not.toHaveBeenCalled()
  })

  it('prepares the selected Claude auth environment before local generation', async () => {
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'do-not-leak-managed-auth-conflict'
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'claude', model: 'claude-haiku-4-5' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Update README'
    })

    try {
      registerFilesystemHandlers(store as never, {
        prepareForClaudeLaunch: async () => ({
          configDir: '/managed/claude',
          envPatch: { CLAUDE_CONFIG_DIR: '/managed/claude' },
          stripAuthEnv: true,
          provenance: 'managed:account-1'
        })
      })

      await handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })

      const target = generateCommitMessageFromContextMock.mock.calls[0]?.[2] as
        | { env?: NodeJS.ProcessEnv }
        | undefined
      expect(target?.env).toEqual(
        expect.objectContaining({
          CLAUDE_CONFIG_DIR: '/managed/claude'
        })
      )
      expect(target?.env?.ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      if (previousAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey
      }
    }
  })

  it('generates an SSH commit message using remote staged context and relay execution', async () => {
    const context = {
      branch: 'main',
      stagedSummary: 'A\tremote.txt',
      stagedPatch: '+remote'
    }
    const params = { agentId: 'custom', model: '', customAgentCommand: 'agent' }
    const executeCommitMessagePlan = vi.fn()
    const prepareForCodexLaunch = vi.fn(() => '/managed/codex-home')
    const prepareForClaudeLaunch = vi.fn()
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getSshGitProviderMock.mockReturnValue({
      getStagedCommitContext: vi.fn().mockResolvedValue(context),
      executeCommitMessagePlan
    })
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Add remote file'
    })

    registerFilesystemHandlers(store as never, {
      prepareForCodexLaunch,
      prepareForClaudeLaunch
    })

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: '/remote/repo',
        connectionId: 'conn-1'
      })
    ).resolves.toEqual({ success: true, message: 'Add remote file' })

    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
      context,
      params,
      expect.objectContaining({
        kind: 'remote',
        cwd: '/remote/repo',
        missingBinaryLocation: 'remote PATH'
      })
    )
    const target = generateCommitMessageFromContextMock.mock.calls[0]?.[2]
    await target.execute(
      { binary: 'agent', args: [], stdinPayload: null, label: 'agent' },
      '/cwd',
      1
    )
    expect(executeCommitMessagePlan).toHaveBeenCalledWith(
      { binary: 'agent', args: [], stdinPayload: null, label: 'agent' },
      '/cwd',
      1
    )
    expect(prepareForCodexLaunch).not.toHaveBeenCalled()
    expect(prepareForClaudeLaunch).not.toHaveBeenCalled()
  })

  it('does not call the generator when no staged changes exist', async () => {
    resolveCommitMessageSettingsMock.mockReturnValue({
      ok: true,
      params: { agentId: 'codex', model: 'gpt-5.4-mini' }
    })
    getStagedCommitContextMock.mockResolvedValue(null)

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual({ success: false, error: 'No staged changes to summarize.' })

    expect(generateCommitMessageFromContextMock).not.toHaveBeenCalled()
  })

  it('sanitizes local staged-context read failures before returning to the renderer', async () => {
    resolveCommitMessageSettingsMock.mockReturnValue({
      ok: true,
      params: { agentId: 'codex', model: 'gpt-5.4-mini' }
    })
    getStagedCommitContextMock.mockRejectedValue(new Error('fatal: /secret/repo failed'))

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual({ success: false, error: 'Failed to read staged changes.' })

    expect(generateCommitMessageFromContextMock).not.toHaveBeenCalled()
  })

  it('sanitizes SSH staged-context read failures before returning to the renderer', async () => {
    resolveCommitMessageSettingsMock.mockReturnValue({
      ok: true,
      params: { agentId: 'codex', model: 'gpt-5.4-mini' }
    })
    getSshGitProviderMock.mockReturnValue({
      getStagedCommitContext: vi.fn().mockRejectedValue(new Error('fatal: /remote/secret failed'))
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: '/remote/repo',
        connectionId: 'conn-1'
      })
    ).resolves.toEqual({ success: false, error: 'Failed to read staged changes.' })

    expect(generateCommitMessageFromContextMock).not.toHaveBeenCalled()
  })

  it('routes ssh git:commit through the SSH provider instead of local commitChanges', async () => {
    const sshCommitMock = vi.fn().mockResolvedValue({ success: true })
    getSshGitProviderMock.mockReturnValue({ commit: sshCommitMock })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: '/remote/repo',
        message: 'feat: remote commit',
        connectionId: 'conn-1'
      })
    ).resolves.toEqual({ success: true })

    expect(sshCommitMock).toHaveBeenCalledWith('/remote/repo', 'feat: remote commit')
    expect(commitChangesMock).not.toHaveBeenCalled()
  })

  it('routes ssh git:bulkDiscard through the SSH provider', async () => {
    const sshBulkDiscardMock = vi.fn().mockResolvedValue(undefined)
    getSshGitProviderMock.mockReturnValue({ bulkDiscardChanges: sshBulkDiscardMock })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:bulkDiscard')!(null, {
      worktreePath: '/remote/repo',
      filePaths: ['a.ts', 'b.ts'],
      connectionId: 'conn-1'
    })

    expect(sshBulkDiscardMock).toHaveBeenCalledWith('/remote/repo', ['a.ts', 'b.ts'])
    expect(bulkDiscardChangesMock).not.toHaveBeenCalled()
  })

  it('rejects git:commit with empty message and does not call commitChanges', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        message: ''
      })
    ).rejects.toThrow('Commit message is required')

    expect(commitChangesMock).not.toHaveBeenCalled()
  })

  it('rejects git:commit with whitespace-only message and does not call commitChanges', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        message: '   '
      })
    ).rejects.toThrow('Commit message is required')

    expect(commitChangesMock).not.toHaveBeenCalled()
  })

  it('rejects git:commit with whitespace-only message before SSH dispatch', async () => {
    const sshCommitMock = vi.fn().mockResolvedValue({ success: true })
    getSshGitProviderMock.mockReturnValue({ commit: sshCommitMock })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: '/remote/repo',
        message: '\n',
        connectionId: 'conn-1'
      })
    ).rejects.toThrow('Commit message is required')

    expect(sshCommitMock).not.toHaveBeenCalled()
  })

  it('allows git operations on worktrees outside repo/workspace roots', async () => {
    // Linked worktrees can live anywhere on disk (e.g. ~/.codex/worktrees/).
    // As long as the path matches a worktree reported by `git worktree list`
    // for a registered repo, it should be allowed — the security boundary is
    // worktree registration, not directory containment.
    const externalWorktreePath = path.resolve('/external/worktrees/feature')
    listWorktreesMock.mockResolvedValue([
      {
        path: REPO_PATH,
        head: 'abc',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: externalWorktreePath,
        head: 'def',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])

    getBranchCompareMock.mockResolvedValue({
      summary: {
        baseRef: 'origin/main',
        baseOid: 'base-oid',
        compareRef: 'feature',
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid',
        changedFiles: 0,
        status: 'ready'
      },
      entries: []
    })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:branchCompare')!(null, {
      worktreePath: externalWorktreePath,
      baseRef: 'origin/main'
    })

    expect(getBranchCompareMock).toHaveBeenCalledWith(externalWorktreePath, 'origin/main')
  })

  it('rejects branchCompare for a worktree added after cache was built, then succeeds after invalidation', async () => {
    // Reproduces the bug where CLI-created worktrees fail with
    // "Access denied: unknown repository or worktree path" because the
    // filesystem-auth cache was not invalidated after creation.
    const cliWorktreePath = path.resolve('/external/cli-created-worktree')

    // Step 1: register handlers and trigger initial cache build with only
    // the original worktree in the listing.
    registerFilesystemHandlers(store as never)

    // Warm the cache by calling a git operation on the existing worktree.
    getStatusMock.mockResolvedValue({ entries: [] })
    await handlers.get('git:status')!(null, { worktreePath: WORKTREE_FEATURE_PATH })

    // Step 2: simulate the CLI creating a new worktree — git now lists it,
    // but the auth cache is stale.
    listWorktreesMock.mockResolvedValue([
      {
        path: WORKTREE_FEATURE_PATH,
        head: 'abc',
        branch: '',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: cliWorktreePath,
        head: 'def',
        branch: 'refs/heads/cli-feature',
        isBare: false,
        isMainWorktree: false
      }
    ])

    // Step 3: branchCompare on the new worktree should fail — this is the
    // exact error the user reported.
    await expect(
      handlers.get('git:branchCompare')!(null, {
        worktreePath: cliWorktreePath,
        baseRef: 'origin/main'
      })
    ).rejects.toThrow('Access denied: unknown repository or worktree path')

    // Step 4: invalidate the cache (what our fix does after CLI create).
    invalidateAuthorizedRootsCache()

    // Step 5: the same branchCompare should now succeed.
    getBranchCompareMock.mockResolvedValue({
      summary: {
        baseRef: 'origin/main',
        baseOid: 'base-oid',
        compareRef: 'cli-feature',
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid',
        changedFiles: 0,
        status: 'ready'
      },
      entries: []
    })

    await handlers.get('git:branchCompare')!(null, {
      worktreePath: cliWorktreePath,
      baseRef: 'origin/main'
    })

    expect(getBranchCompareMock).toHaveBeenCalledWith(cliWorktreePath, 'origin/main')
  })

  it('routes branch diff queries through the pinned branch diff helper', async () => {
    getBranchDiffMock.mockResolvedValue({
      kind: 'text',
      originalContent: 'left',
      modifiedContent: 'right',
      originalIsBinary: false,
      modifiedIsBinary: false
    })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:branchDiff')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      compare: {
        baseRef: 'origin/main',
        baseOid: 'base-oid',
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid'
      },
      filePath: 'src/file.ts',
      oldPath: 'src/old-file.ts'
    })

    // Why: validateGitRelativeFilePath uses path.relative() which produces
    // platform-specific separators (backslashes on Windows).
    expect(getBranchDiffMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
      headOid: 'head-oid',
      mergeBase: 'merge-base-oid',
      filePath: path.join('src', 'file.ts'),
      oldPath: path.join('src', 'old-file.ts')
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
})
