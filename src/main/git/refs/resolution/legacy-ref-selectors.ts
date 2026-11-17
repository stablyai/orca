import type { BaseRefSearchResult } from '../../../../shared/repository/repo-types'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { gitExecOptions, type LocalGitExecOptions } from './repo-default-base-ref'
import { resolveBaseRefSearchSelector } from './base-ref-search-selector'

/** canonical: full refs; git-short: Git's short name, qualified only when ambiguous; unqualified: ambiguous refs omitted. */
export type RepoSearchRefSelectorForm = 'canonical' | 'git-short' | 'unqualified'

// Windows caps a command line at 32K, and WSL's login-shell fallback repeats the command three times.
const MAX_PATTERN_CHARS_PER_CALL = 6_000
// Each nested POSIX single-quoting level grows an apostrophe from 1 to 4 characters; budget two levels.
const QUOTED_APOSTROPHE_CHARS = 16

/** Older clients display refName raw, so give one page the selectors pre-snapshot hosts sent. */
export async function toGitShortRefSelectors(
  path: string,
  refDetails: BaseRefSearchResult[],
  git: LocalGitExecOptions = {}
): Promise<BaseRefSearchResult[]> {
  const shortByRef = new Map<string, string>()
  for (const patterns of chunkByLength(refDetails.map(({ refName }) => refName))) {
    try {
      const { stdout } = await gitExecFileAsync(
        ['for-each-ref', '--format=%(refname)%00%(refname:short)', ...patterns],
        gitExecOptions(path, git)
      )
      for (const line of stdout.split('\n')) {
        const [full, short] = line.replace(/\r$/, '').split('\0')
        if (full && short) {
          shortByRef.set(full, short)
        }
      }
    } catch (err) {
      console.warn('[searchBaseRefs] short ref selectors failed', { path, err })
    }
  }
  return refDetails.map((row) => {
    const short = shortByRef.get(row.refName)
    return short === undefined
      ? row
      : { ...row, refName: resolveBaseRefSearchSelector(row.refName, short) }
  })
}

function chunkByLength(refNames: string[]): string[][] {
  const chunks: string[][] = []
  let chunk: string[] = []
  let length = 0
  for (const refName of refNames) {
    const apostrophes = refName.split("'").length - 1
    const quotedLength = refName.length + 1 + apostrophes * (QUOTED_APOSTROPHE_CHARS - 1)
    if (chunk.length > 0 && length + quotedLength > MAX_PATTERN_CHARS_PER_CALL) {
      chunks.push(chunk)
      chunk = []
      length = 0
    }
    chunk.push(refName)
    length += quotedLength
  }
  if (chunk.length > 0) {
    chunks.push(chunk)
  }
  return chunks
}
