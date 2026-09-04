// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithSearchLocalRuntimeFiles } from './runtime-file-commands-search-local-runtime-files'
import type { IFilesystemProvider } from '../providers/types'
import {
  MOBILE_FILE_READ_MAX_BYTES,
  QUICK_OPEN_LEGACY_REMOTE_RESULT_LIMIT
} from './runtime-file-commands-mobile-file-list-limit'
import { QuickOpenPathRanker } from '../../shared/quick-open-path-search'
import type { PluginReadGrant } from '../../shared/plugins/plugin-read-confinement'
import { isPluginReadAllowed } from '../../shared/plugins/plugin-read-confinement'
import { isMobileBinaryPath, isSafeMobileRelativePath } from './runtime-file-command-host'
import { readLocalMobileFile } from './runtime-file-commands-terminal-file-paths'
import { truncateMobileFilePreview } from './runtime-file-commands-terminal-artifact-access'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { readdir, stat } from 'node:fs/promises'
import { isRuntimeDirectoryEntry } from './runtime-file-command-host'
import { sortDirEntries } from '../../shared/file-name-sort'
import { runtimeFileRouteForTarget } from './runtime-file-command-target'

export type PluginFileMethod = 'files.read' | 'files.stat' | 'files.readDir'

export type PluginFileExecutionResult = { authorized: false } | { authorized: true; value: unknown }

export class RuntimeFileCommandsWithSearchRemoteQuickOpenFilePaths extends RuntimeFileCommandsWithSearchLocalRuntimeFiles {
  async executePluginFileMethod(
    method: PluginFileMethod,
    worktreeSelector: string,
    relativePath: string,
    grant: PluginReadGrant
  ): Promise<PluginFileExecutionResult> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const route = runtimeFileRouteForTarget(target)
    const provider = route.kind === 'ssh' ? route.provider : null
    if (route.kind === 'ssh' && !provider) {
      return { authorized: false }
    }
    const store = this.host.requireStore()
    const [canonicalRoot, canonicalTarget] = provider
      ? await Promise.all([provider.realpath(target.worktree.path), provider.realpath(target.path)])
      : await Promise.all([
          resolveAuthorizedPath(target.worktree.path, store),
          resolveAuthorizedPath(target.path, store)
        ])
    if (!isPluginReadAllowed(canonicalRoot, canonicalTarget, grant)) {
      return { authorized: false }
    }
    if (method === 'files.read') {
      if (!isSafeMobileRelativePath(relativePath)) {
        throw new Error('invalid_relative_path')
      }
      if (isMobileBinaryPath(relativePath)) {
        throw new Error('binary_file')
      }
      const content = provider
        ? await this.readRemoteMobileFile(canonicalTarget, provider)
        : await readLocalMobileFile(canonicalTarget, store)
      return {
        authorized: true,
        value: { content: truncateMobileFilePreview(content).content, encoding: 'utf8' as const }
      }
    }
    if (method === 'files.stat') {
      const fileStat = provider ? await provider.stat(canonicalTarget) : await stat(canonicalTarget)
      return {
        authorized: true,
        value: {
          size: fileStat.size,
          isDirectory: provider ? fileStat.type === 'directory' : fileStat.isDirectory(),
          mtime: provider ? fileStat.mtime : fileStat.mtimeMs
        }
      }
    }
    const entries = provider
      ? sortDirEntries(await provider.readDir(canonicalTarget))
      : sortDirEntries(
          (await readdir(canonicalTarget, { withFileTypes: true })).map((entry) => ({
            name: entry.name,
            isDirectory: isRuntimeDirectoryEntry(entry),
            isSymlink: entry.isSymbolicLink()
          }))
        )
    return {
      authorized: true,
      value: { entries: entries.map(({ name, isDirectory }) => ({ name, isDirectory })) }
    }
  }

  protected async searchRemoteQuickOpenFilePaths(
    rootPath: string,
    // `null` is "remote and currently unreachable": quick open reports no matches rather than
    // failing the keystroke, but it never falls back to searching this machine.
    provider: IFilesystemProvider | null,
    query: string,
    limit: number,
    excludePaths?: string[],
    signal?: AbortSignal
  ): Promise<{ paths: string[]; totalCount: number; truncated: boolean }> {
    if (!provider) {
      return { paths: [], totalCount: 0, truncated: false }
    }
    if (!(await provider.supportsQuickOpenSearch?.({ signal }))) {
      // Old relays ignore searchQuery. Keep the compatibility request below the
      // 4 MiB frame ceiling even when legacy paths are near the 64 KiB path cap.
      const legacyFiles = await provider.listFiles(rootPath, {
        excludePaths,
        maxResults: QUICK_OPEN_LEGACY_REMOTE_RESULT_LIMIT,
        signal
      })
      const ranker = new QuickOpenPathRanker(query, limit)
      for (const file of legacyFiles) {
        ranker.consider(file)
      }
      const result = ranker.result()
      return {
        ...result,
        truncated:
          legacyFiles.length >= QUICK_OPEN_LEGACY_REMOTE_RESULT_LIMIT || result.totalCount > limit
      }
    }
    const files = await provider.listFiles(rootPath, {
      excludePaths,
      maxResults: limit + 1,
      searchQuery: query,
      signal
    })
    return {
      paths: files.slice(0, limit),
      totalCount: files.length,
      truncated: files.length > limit
    }
  }

  protected async readRemoteMobileFile(
    filePath: string,
    provider: IFilesystemProvider
  ): Promise<string> {
    const fileStat = await provider.stat(filePath)
    // Why: no ranged reads over SSH here, so reject oversized previews instead of streaming a whole file just to trim it.
    if (fileStat.size > MOBILE_FILE_READ_MAX_BYTES) {
      throw new Error('file_too_large')
    }
    const result = await provider.readFile(filePath)
    if (result.isBinary) {
      throw new Error('binary_file')
    }
    return result.content
  }
}
