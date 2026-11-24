import type { BaseRefSearchResult } from '../../../../shared/repository/repo-types'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { gitExecOptions } from './repo-default-base-ref'
import { resolveBaseRefSearchSelector } from './base-ref-search-selector'

/** canonical: full refs; git-short: Git's short name, qualified only when ambiguous; unqualified: ambiguous refs omitted. */
export type RepoSearchRefSelectorForm = 'canonical' | 'git-short' | 'unqualified'

// WSL's login-shell fallback quotes each argument twice and repeats the command three times; Windows caps it at 32K.
const MAX_REF_CHARS_PER_CALL = 4_000
const REF_QUOTING_CHARS = 10
// Quotes are the only ref-name characters shell or Windows quoting grows; such refs keep their full name.
const QUOTE_CHARACTER = /['"]/

/** Older clients display refName raw, so give one page the selectors pre-snapshot hosts sent. */
export async function toGitShortRefSelectors(
  path: string,
  refDetails: BaseRefSearchResult[],
  signal?: AbortSignal
): Promise<BaseRefSearchResult[]> {
  const shortByRef = new Map<string, string>()
  const refs = refDetails.map(({ refName }) => refName).filter((ref) => !QUOTE_CHARACTER.test(ref))
  for (const chunk of chunkByLength(refs)) {
    signal?.throwIfAborted()
    try {
      // Same shortening as %(refname:short), but by exact lookups; for-each-ref reads whole loose-ref directories.
      // --revs-only makes a ref deleted since the snapshot end the output instead of failing (and retrying via WSL).
      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--revs-only', '--abbrev-ref', ...chunk],
        {
          ...gitExecOptions(path),
          signal
        }
      )
      const shorts = stdout.split(/\r?\n/).filter(Boolean)
      // Output is positional and Git may drop a line for a ref it can't resolve, so a short count trusts none of it.
      if (shorts.length === chunk.length) {
        chunk.forEach((ref, index) => shortByRef.set(ref, shorts[index]))
      }
    } catch (err) {
      signal?.throwIfAborted()
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

function chunkByLength(refs: string[]): string[][] {
  const chunks: string[][] = []
  let chunk: string[] = []
  let length = 0
  for (const ref of refs) {
    const quotedLength = ref.length + REF_QUOTING_CHARS
    if (chunk.length > 0 && length + quotedLength > MAX_REF_CHARS_PER_CALL) {
      chunks.push(chunk)
      chunk = []
      length = 0
    }
    chunk.push(ref)
    length += quotedLength
  }
  if (chunk.length > 0) {
    chunks.push(chunk)
  }
  return chunks
}
