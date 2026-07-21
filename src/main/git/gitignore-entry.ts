import { constants, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppendGitignoreEntriesResult, GitignoreEntry } from '../../shared/gitignore-entry'
import {
  MAX_GITIGNORE_ENTRY_COUNT,
  MAX_GITIGNORE_RELATIVE_PATH_LENGTH
} from '../../shared/gitignore-entry'

type PreparedGitignoreEntry = GitignoreEntry & {
  pattern: string
  equivalentPatterns: string[]
}

const appendQueues = new Map<string, Promise<void>>()
const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
// 为什么：同一文件句柄完成读取和追加，避免恶意仓库在检查后把 .gitignore 换成工作树外的符号链接。
const APPEND_FILE_FLAGS = constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | OPEN_NOFOLLOW

function hasErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  return (error as { code?: unknown }).code === code
}

function openedSameFile(pathStats: Stats, openedStats: Stats): boolean {
  // 为什么：部分虚拟或网络文件系统不提供 dev/ino，缺失时不能把合法文件误判为被替换。
  if (
    pathStats.dev === 0 ||
    openedStats.dev === 0 ||
    pathStats.ino === 0 ||
    openedStats.ino === 0
  ) {
    return true
  }
  return pathStats.dev === openedStats.dev && pathStats.ino === openedStats.ino
}

function escapeGitignorePath(relativePath: string): string {
  return relativePath.replace(/([*?[\]#! ])/g, '\\$1')
}

function prepareGitignoreEntries(entries: unknown): PreparedGitignoreEntry[] {
  if (!Array.isArray(entries)) {
    throw new Error('Gitignore entries must be an array')
  }
  if (entries.length > MAX_GITIGNORE_ENTRY_COUNT) {
    throw new Error(`Cannot add more than ${MAX_GITIGNORE_ENTRY_COUNT} gitignore entries at once`)
  }

  const prepared: PreparedGitignoreEntry[] = []
  const seenPatterns = new Set<string>()
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('Invalid gitignore entry')
    }
    const { relativePath, isDirectory } = entry as Partial<GitignoreEntry>
    if (
      typeof relativePath !== 'string' ||
      relativePath.length === 0 ||
      relativePath.length > MAX_GITIGNORE_RELATIVE_PATH_LENGTH
    ) {
      throw new Error('Invalid gitignore relative path')
    }
    if (typeof isDirectory !== 'boolean') {
      throw new Error('Invalid gitignore entry type')
    }
    if (relativePath.includes('\0') || relativePath.includes('\r') || relativePath.includes('\n')) {
      throw new Error('Gitignore paths cannot contain NUL or newline characters')
    }

    const normalizedPath = relativePath.replace(/\\/g, '/')
    if (
      normalizedPath.startsWith('/') ||
      /^[A-Za-z]:/.test(normalizedPath) ||
      normalizedPath
        .split('/')
        .some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new Error(`Gitignore path must stay inside the worktree: ${relativePath}`)
    }

    const escapedPath = escapeGitignorePath(normalizedPath)
    const pattern = isDirectory ? `${escapedPath}/` : escapedPath
    if (seenPatterns.has(pattern)) {
      continue
    }
    seenPatterns.add(pattern)
    prepared.push({
      relativePath: normalizedPath,
      isDirectory,
      pattern,
      equivalentPatterns: isDirectory ? [pattern, escapedPath] : [pattern]
    })
  }
  return prepared
}

function buildAppendResult(
  existingContent: string,
  entries: PreparedGitignoreEntry[]
): { result: AppendGitignoreEntriesResult; contentToAppend: string } {
  if (existingContent.includes('\0')) {
    throw new Error('Cannot update a binary .gitignore file')
  }
  const existingPatterns = new Set(
    existingContent.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  )
  const addedEntries: PreparedGitignoreEntry[] = []
  const alreadyPresent: string[] = []
  for (const entry of entries) {
    if (entry.equivalentPatterns.some((pattern) => existingPatterns.has(pattern))) {
      alreadyPresent.push(entry.relativePath)
    } else {
      addedEntries.push(entry)
    }
  }

  if (addedEntries.length === 0) {
    return { result: { added: [], alreadyPresent }, contentToAppend: '' }
  }

  const newline = existingContent.includes('\r\n') ? '\r\n' : '\n'
  const leadingNewline =
    existingContent.length > 0 && !existingContent.endsWith('\n') ? newline : ''
  const contentToAppend = `${leadingNewline}${addedEntries.map((entry) => entry.pattern).join(newline)}${newline}`
  return {
    result: {
      added: addedEntries.map((entry) => entry.relativePath),
      alreadyPresent
    },
    contentToAppend
  }
}

async function enqueueGitignoreAppend<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = appendQueues.get(lockKey) ?? Promise.resolve()
  const running = previous.catch(() => {}).then(operation)
  const tail = running.then(
    () => undefined,
    () => undefined
  )
  appendQueues.set(lockKey, tail)
  try {
    return await running
  } finally {
    if (appendQueues.get(lockKey) === tail) {
      appendQueues.delete(lockKey)
    }
  }
}

export async function appendGitignoreEntries(
  worktreePath: string,
  entries: unknown
): Promise<AppendGitignoreEntriesResult> {
  const preparedEntries = prepareGitignoreEntries(entries)
  if (preparedEntries.length === 0) {
    return { added: [], alreadyPresent: [] }
  }
  const gitignorePath = join(worktreePath, '.gitignore')
  return enqueueGitignoreAppend(`local:${gitignorePath}`, async () => {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(gitignorePath, APPEND_FILE_FLAGS)
    } catch (error) {
      if (hasErrorCode(error, 'ELOOP')) {
        throw new Error('Cannot update a symbolic-link .gitignore file')
      }
      throw error
    }
    try {
      const [pathStats, openedStats] = await Promise.all([lstat(gitignorePath), handle.stat()])
      if (pathStats.isSymbolicLink()) {
        throw new Error('Cannot update a symbolic-link .gitignore file')
      }
      if (!pathStats.isFile() || !openedStats.isFile()) {
        throw new Error('Cannot update a non-regular .gitignore file')
      }
      if (!openedSameFile(pathStats, openedStats)) {
        throw new Error('.gitignore changed while it was being opened')
      }
      const existingContent = await handle.readFile({ encoding: 'utf8' })
      const { result, contentToAppend } = buildAppendResult(existingContent, preparedEntries)
      if (contentToAppend) {
        await handle.writeFile(contentToAppend, { encoding: 'utf8' })
      }
      return result
    } finally {
      await handle.close()
    }
  })
}
