// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithSearchLocalRuntimeFiles } from './runtime-file-commands-search-local-runtime-files'
import type { IFilesystemProvider } from '../providers/types'
import {
  MOBILE_FILE_READ_MAX_BYTES,
  QUICK_OPEN_LEGACY_REMOTE_RESULT_LIMIT
} from './runtime-file-commands-mobile-file-list-limit'
import { QuickOpenPathRanker } from '../../shared/quick-open-path-search'

export class RuntimeFileCommandsWithSearchRemoteQuickOpenFilePaths extends RuntimeFileCommandsWithSearchLocalRuntimeFiles {
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
