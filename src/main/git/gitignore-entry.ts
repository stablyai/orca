import { constants } from 'node:fs'
import { appendFile, lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppendGitignoreEntriesResult, GitignoreEntry } from '../../shared/gitignore-entry'
import {
  MAX_GITIGNORE_ENTRY_COUNT,
  MAX_GITIGNORE_RELATIVE_PATH_LENGTH
} from '../../shared/gitignore-entry'
import type { IFilesystemProvider } from '../providers/types'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'

type PreparedGitignoreEntry = GitignoreEntry & {
  pattern: string
  equivalentPatterns: string[]
}

type GitignoreFileAccess = {
  lockKey: string
  readExisting(): Promise<string | null>
  append(content: string): Promise<void>
}

const appendQueues = new Map<string, Promise<void>>()
const APPEND_FILE_FLAGS =
  constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW

function isMissingFileError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const candidate = error as { code?: unknown; message?: unknown }
  return (
    candidate.code === 'ENOENT' ||
    (typeof candidate.message === 'string' && /\bENOENT\b|no such file/i.test(candidate.message))
  )
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
  const addedEntries = entries.filter(
    (entry) => !entry.equivalentPatterns.some((pattern) => existingPatterns.has(pattern))
  )
  const alreadyPresent = entries
    .filter((entry) => !addedEntries.includes(entry))
    .map((entry) => entry.relativePath)

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

async function appendEntriesWithAccess(
  entries: unknown,
  access: GitignoreFileAccess
): Promise<AppendGitignoreEntriesResult> {
  const preparedEntries = prepareGitignoreEntries(entries)
  if (preparedEntries.length === 0) {
    return { added: [], alreadyPresent: [] }
  }
  return enqueueGitignoreAppend(access.lockKey, async () => {
    const existingContent = (await access.readExisting()) ?? ''
    const { result, contentToAppend } = buildAppendResult(existingContent, preparedEntries)
    if (contentToAppend) {
      await access.append(contentToAppend)
    }
    return result
  })
}

export async function appendGitignoreEntries(
  worktreePath: string,
  entries: unknown
): Promise<AppendGitignoreEntriesResult> {
  const gitignorePath = join(worktreePath, '.gitignore')
  return appendEntriesWithAccess(entries, {
    lockKey: `local:${gitignorePath}`,
    readExisting: async () => {
      try {
        const stats = await lstat(gitignorePath)
        if (stats.isSymbolicLink()) {
          throw new Error('Cannot update a symbolic-link .gitignore file')
        }
        if (!stats.isFile()) {
          throw new Error('Cannot update a non-regular .gitignore file')
        }
        return await readFile(gitignorePath, 'utf8')
      } catch (error) {
        if (isMissingFileError(error)) {
          return null
        }
        throw error
      }
    },
    append: (content) =>
      appendFile(gitignorePath, content, { encoding: 'utf8', flag: APPEND_FILE_FLAGS })
  })
}

export async function appendGitignoreEntriesWithProvider(
  worktreePath: string,
  entries: unknown,
  provider: Pick<IFilesystemProvider, 'readFile' | 'writeFileBase64Chunk'> &
    Partial<Pick<IFilesystemProvider, 'lstat'>>
): Promise<AppendGitignoreEntriesResult> {
  const gitignorePath = joinWorktreeRelativePath(worktreePath, '.gitignore')
  return appendEntriesWithAccess(entries, {
    lockKey: `provider:${gitignorePath}`,
    readExisting: async () => {
      try {
        const stats = await provider.lstat?.(gitignorePath)
        if (stats?.type === 'symlink') {
          throw new Error('Cannot update a symbolic-link .gitignore file')
        }
        if (stats && stats.type !== 'file') {
          throw new Error('Cannot update a non-regular .gitignore file')
        }
        const result = await provider.readFile(gitignorePath)
        if (result.isBinary) {
          throw new Error('Cannot update a binary .gitignore file')
        }
        return result.content
      } catch (error) {
        if (isMissingFileError(error)) {
          return null
        }
        throw error
      }
    },
    append: (content) =>
      provider.writeFileBase64Chunk(
        gitignorePath,
        Buffer.from(content, 'utf8').toString('base64'),
        true
      )
  })
}
