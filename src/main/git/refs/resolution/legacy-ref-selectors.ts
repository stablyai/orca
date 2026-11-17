import type { BaseRefSearchResult } from '../../../../shared/repository/repo-types'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { gitExecOptions, type LocalGitExecOptions } from './repo-default-base-ref'
import { resolveBaseRefSearchSelector } from './base-ref-search-selector'

/** canonical: full refs; git-short: Git's short name, qualified only when ambiguous; unqualified: ambiguous refs omitted. */
export type RepoSearchRefSelectorForm = 'canonical' | 'git-short' | 'unqualified'

// Keeps each for-each-ref argv well under Windows' 32K command-line limit.
const MAX_PATTERN_CHARS_PER_CALL = 16_000

/** Older clients display refName raw, so give one page the selectors pre-snapshot hosts sent. */
export async function toGitShortRefSelectors(
  path: string,
  refDetails: BaseRefSearchResult[],
  git: LocalGitExecOptions = {}
): Promise<BaseRefSearchResult[]> {
  const shortByRef = new Map<string, string>()
  try {
    for (const patterns of chunkByLength(refDetails.map(({ refName }) => refName))) {
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
    }
  } catch (err) {
    console.warn('[searchBaseRefs] short ref selectors failed', { path, err })
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
    if (chunk.length > 0 && length + refName.length > MAX_PATTERN_CHARS_PER_CALL) {
      chunks.push(chunk)
      chunk = []
      length = 0
    }
    chunk.push(refName)
    length += refName.length + 1
  }
  if (chunk.length > 0) {
    chunks.push(chunk)
  }
  return chunks
}
