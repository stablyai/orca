import type { BaseRefSearchResult } from '../../../../shared/repository/repo-types'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { gitExecOptions } from './repo-default-base-ref'
import { resolveBaseRefSearchSelector } from './base-ref-search-selector'

/** canonical: full refs; git-short: Git's short name, qualified only when ambiguous; unqualified: ambiguous refs omitted. */
export type RepoSearchRefSelectorForm = 'canonical' | 'git-short' | 'unqualified'

// WSL's login-shell fallback quotes each pattern twice and repeats the command three times; Windows caps it at 32K.
const MAX_PATTERN_CHARS_PER_CALL = 4_000
const PATTERN_QUOTING_CHARS = 10
// Quotes are the only ref-name characters shell or Windows quoting grows; such refs keep their full name.
const QUOTE_CHARACTER = /['"]/

/** Older clients display refName raw, so give one page the selectors pre-snapshot hosts sent. */
export async function toGitShortRefSelectors(
  path: string,
  refDetails: BaseRefSearchResult[],
  signal?: AbortSignal
): Promise<BaseRefSearchResult[]> {
  const shortByRef = new Map<string, string>()
  const patterns = refDetails.flatMap(({ refName }) => exactRefPattern(refName) ?? [])
  for (const chunk of chunkByLength(patterns)) {
    signal?.throwIfAborted()
    try {
      const { stdout } = await gitExecFileAsync(
        ['for-each-ref', '--format=%(refname)%00%(refname:short)', ...chunk],
        { ...gitExecOptions(path), signal }
      )
      for (const line of stdout.split('\n')) {
        const [full, short] = line.replace(/\r$/, '').split('\0')
        if (full && short) {
          shortByRef.set(full, short)
        }
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

/**
 * A plain pattern also matches every ref below it; refs can't hold glob characters, so any bracketed character makes
 * the pattern an exact glob. Git's classes match one byte and `[!` negates, so bracket the last single-byte character.
 */
function exactRefPattern(refName: string): string | null {
  if (QUOTE_CHARACTER.test(refName)) {
    return null
  }
  for (let index = refName.length - 1; index >= 0; index--) {
    const char = refName[index]
    if (char.charCodeAt(0) < 0x80 && char !== '!' && char !== '/') {
      return `${refName.slice(0, index)}[${char}]${refName.slice(index + 1)}`
    }
  }
  return null
}

function chunkByLength(patterns: string[]): string[][] {
  const chunks: string[][] = []
  let chunk: string[] = []
  let length = 0
  for (const pattern of patterns) {
    const quotedLength = pattern.length + PATTERN_QUOTING_CHARS
    if (chunk.length > 0 && length + quotedLength > MAX_PATTERN_CHARS_PER_CALL) {
      chunks.push(chunk)
      chunk = []
      length = 0
    }
    chunk.push(pattern)
    length += quotedLength
  }
  if (chunk.length > 0) {
    chunks.push(chunk)
  }
  return chunks
}
