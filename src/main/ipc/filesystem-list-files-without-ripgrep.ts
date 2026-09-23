import { isQuickOpenReaddirBudgetError } from '../../shared/quick-open-readdir-walk'
import { buildInstallRgMessage } from '../../shared/quick-open-install-rg'
import { limitQuickOpenFilesBySerializedBytes } from '../../shared/quick-open-transport-budget'
import { listFilesWithGit } from './filesystem-list-files-git-fallback'

/** Quick Open listing through git/readdir when ripgrep is unavailable. */
export async function listFilesWithoutRipgrep(args: {
  rootPath: string
  excludePathPrefixes: readonly string[]
  localGitOptions: { wslDistro?: string }
  signal?: AbortSignal
  maxResults?: number
  maxSerializedBytes?: number
  pathFilter?: (relativePath: string) => boolean
}): Promise<string[]> {
  const { rootPath, excludePathPrefixes, localGitOptions, signal, maxResults, pathFilter } = args
  try {
    // Why: these fallbacks cap scanned files, not matches, so a filtered listing scans everything.
    // An over-budget readdir walk rejects, and the renderer falls back to its capped listing.
    const files = pathFilter
      ? (await listFilesWithGit(rootPath, excludePathPrefixes, localGitOptions, signal))
          .filter(pathFilter)
          .slice(0, maxResults)
      : await listFilesWithGit(rootPath, excludePathPrefixes, localGitOptions, signal, maxResults)
    return args.maxSerializedBytes === undefined
      ? files
      : limitQuickOpenFilesBySerializedBytes(files, args.maxSerializedBytes)
  } catch (err) {
    if (!isQuickOpenReaddirBudgetError(err)) {
      throw err
    }
    throw new Error(await buildInstallRgMessage(err))
  }
}
