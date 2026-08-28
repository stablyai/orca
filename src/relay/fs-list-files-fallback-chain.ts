import { execFile } from 'node:child_process'
import { listFilesWithRg } from './fs-handler-utils'
import { listFilesWithGit } from './fs-handler-git-fallback'
import { listFilesWithReaddir } from './fs-handler-readdir-fallback'
import {
  isFileListingCancellation,
  throwIfFileListingCancelled
} from '../shared/file-listing-cancellation'
import { isQuickOpenReaddirBudgetError } from '../shared/quick-open-readdir-walk'
import { buildInstallRgMessage, buildRipgrepRequiredMessage } from './fs-handler-install-rg'
import { buildRelayCommandEnv } from './relay-command-env'
import { RipgrepUnavailableError } from '../shared/ripgrep-process-availability'
import { QuickOpenPathRanker } from '../shared/quick-open-path-search'

export async function runListFilesScan(
  rootPath: string,
  excludePathPrefixes: string[],
  signal: AbortSignal,
  maxResults?: number,
  searchQuery?: string
): Promise<string[]> {
  throwIfFileListingCancelled(signal)
  try {
    return await listFilesWithRg(rootPath, excludePathPrefixes, {
      signal,
      maxResults,
      searchQuery
    })
  } catch (error) {
    throwIfFileListingCancelled(signal)
    if (!(error instanceof RipgrepUnavailableError)) {
      throw error
    }
  }
  if (searchQuery !== undefined) {
    throw new Error(await buildRipgrepRequiredMessage())
  }
  // Why: git ls-files only works inside git repos. Use rev-parse to detect
  // git ancestry — unlike checking for a local .git entry, this works from
  // subdirectories of a checkout (e.g. /repo/packages/app added as a folder).
  // Without this, a git subdirectory would fall through to readdir and
  // surface .gitignore'd build artifacts.
  const isGitRepo = await new Promise<boolean>((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: rootPath, env: buildRelayCommandEnv() },
      (err) => resolve(!err)
    )
  })
  if (isGitRepo) {
    // Why: a git monorepo parent fills nested-repo subtrees via the readdir
    // walk, which can exhaust the same cap/deadline. Translate only those
    // budget errors into install-rg guidance; genuine git failures keep
    // their own messages.
    try {
      return rankFallbackFiles(
        await listFilesWithGit(rootPath, excludePathPrefixes, {
          signal,
          maxResults: searchQuery === undefined ? maxResults : undefined
        }),
        searchQuery,
        maxResults
      )
    } catch (err) {
      if (isQuickOpenReaddirBudgetError(err)) {
        throw new Error(await buildInstallRgMessage(err))
      }
      throw err
    }
  }
  // Why: the readdir walker rejects on cap/deadline instead of returning a
  // partial list (design doc: silent truncation is worse than an explicit
  // error). On a home-root without rg that's almost always an install-rg
  // problem, so translate the opaque cap error into actionable guidance
  // the user can act on directly from the error toast.
  try {
    return rankFallbackFiles(
      await listFilesWithReaddir(rootPath, excludePathPrefixes, {
        signal,
        maxResults: searchQuery === undefined ? maxResults : undefined
      }),
      searchQuery,
      maxResults
    )
  } catch (err) {
    // Why: a cancelled scan is not an rg-availability problem; wrapping it
    // in install-rg guidance would surface bogus advice on the client.
    if (isFileListingCancellation(err)) {
      throw err
    }
    throw new Error(await buildInstallRgMessage(err))
  }
}

function rankFallbackFiles(
  files: readonly string[],
  query: string | undefined,
  limit: number | undefined
): string[] {
  if (query === undefined) {
    return [...files]
  }
  const ranker = new QuickOpenPathRanker(query, limit ?? 16)
  for (const file of files) {
    ranker.consider(file)
  }
  return ranker.result().paths
}
