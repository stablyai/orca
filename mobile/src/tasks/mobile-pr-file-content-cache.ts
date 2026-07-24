import { MAX_RENDERED_DIFF_COMBINED_CHARACTERS } from '../../../src/shared/large-diff-render-limit'
import type { GitHubPRFileContents, GitHubRepositoryIdentity } from '../../../src/shared/types'

export const MOBILE_PR_FILE_CONTENT_CACHE_MAX_ENTRIES = 8
export const MOBILE_PR_FILE_CONTENT_CACHE_MAX_BYTES = MAX_RENDERED_DIFF_COMBINED_CHARACTERS * 4

export type MobilePrFileContentScopeInput = {
  source: 'item' | 'project'
  repoId: string
  prNumber: number
  headSha: string
  baseSha: string
  repository?: GitHubRepositoryIdentity | null
}

export type MobilePrFileContentKeyInput = {
  path: string
  oldPath?: string
  status?: string
}

export type MobilePrFileContentRequestToken = {
  scope: string
  key: string
  requestId: number
}

export type MobilePrFileContentCacheSnapshot = {
  scope: string | null
  contentsByKey: Readonly<Record<string, GitHubPRFileContents | undefined>>
}

export type MobilePrFileContentCacheEvidence = {
  scope: string | null
  entryCount: number
  retainedBytes: number
  keysOldestFirst: string[]
}

type CacheEntry = {
  contents: GitHubPRFileContents
  byteCount: number
}

type CacheSelection = {
  contents: GitHubPRFileContents | undefined
  scopeChanged: boolean
}

export class MobilePrFileContentCache {
  private readonly entries = new Map<string, CacheEntry>()
  private scope: string | null = null
  private retainedBytes = 0
  private requestSequence = 0
  private activeRequest: MobilePrFileContentRequestToken | null = null

  constructor(
    private readonly maxEntries = MOBILE_PR_FILE_CONTENT_CACHE_MAX_ENTRIES,
    private readonly maxBytes = MOBILE_PR_FILE_CONTENT_CACHE_MAX_BYTES
  ) {
    if (
      !Number.isInteger(maxEntries) ||
      maxEntries < 1 ||
      !Number.isFinite(maxBytes) ||
      maxBytes < 1
    ) {
      throw new Error('Mobile PR file-content cache limits must be positive')
    }
  }

  activateScope(scope: string): boolean {
    if (this.scope === scope) {
      return false
    }
    this.scope = scope
    this.entries.clear()
    this.retainedBytes = 0
    this.activeRequest = null
    return true
  }

  clear(): void {
    this.scope = null
    this.entries.clear()
    this.retainedBytes = 0
    this.activeRequest = null
  }

  select(scope: string, key: string): CacheSelection {
    const scopeChanged = this.activateScope(scope)
    this.activeRequest = null
    const entry = this.entries.get(key)
    if (!entry) {
      return { contents: undefined, scopeChanged }
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return { contents: entry.contents, scopeChanged }
  }

  beginRequest(scope: string, key: string): MobilePrFileContentRequestToken {
    this.activateScope(scope)
    const token = { scope, key, requestId: ++this.requestSequence }
    this.activeRequest = token
    return token
  }

  commitRequest(
    token: MobilePrFileContentRequestToken,
    contents: GitHubPRFileContents
  ): 'stored' | 'stale' | 'too-large' {
    if (!this.isCurrentRequest(token)) {
      return 'stale'
    }
    this.activeRequest = null
    const byteCount = getMobilePrFileContentByteCount(contents)
    if (byteCount > this.maxBytes) {
      return 'too-large'
    }
    const previous = this.entries.get(token.key)
    this.retainedBytes -= previous?.byteCount ?? 0
    this.entries.delete(token.key)
    this.entries.set(token.key, { contents, byteCount })
    this.retainedBytes += byteCount
    this.evictOverflow()
    return 'stored'
  }

  rejectRequest(token: MobilePrFileContentRequestToken): boolean {
    if (!this.isCurrentRequest(token)) {
      return false
    }
    this.activeRequest = null
    return true
  }

  snapshot(): MobilePrFileContentCacheSnapshot {
    return {
      scope: this.scope,
      contentsByKey: Object.fromEntries(
        [...this.entries].map(([key, entry]) => [key, entry.contents])
      )
    }
  }

  evidence(): MobilePrFileContentCacheEvidence {
    return {
      scope: this.scope,
      entryCount: this.entries.size,
      retainedBytes: this.retainedBytes,
      keysOldestFirst: [...this.entries.keys()]
    }
  }

  private isCurrentRequest(token: MobilePrFileContentRequestToken): boolean {
    return (
      this.scope === token.scope &&
      this.activeRequest?.requestId === token.requestId &&
      this.activeRequest.scope === token.scope &&
      this.activeRequest.key === token.key
    )
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries || this.retainedBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value
      if (typeof oldestKey !== 'string') {
        return
      }
      const oldest = this.entries.get(oldestKey)
      this.retainedBytes -= oldest?.byteCount ?? 0
      this.entries.delete(oldestKey)
    }
  }
}

export function createMobilePrFileContentScope(input: MobilePrFileContentScopeInput): string {
  return JSON.stringify([
    input.source,
    input.repoId,
    input.prNumber,
    input.repository?.host?.toLowerCase() ?? '',
    input.repository?.owner.toLowerCase() ?? '',
    input.repository?.repo.toLowerCase() ?? '',
    input.headSha,
    input.baseSha
  ])
}

export function createMobilePrFileContentKey(input: MobilePrFileContentKeyInput): string {
  return input.path
}

export function getMobilePrFileContentsForScope(
  snapshot: MobilePrFileContentCacheSnapshot,
  scope: string | null
): Readonly<Record<string, GitHubPRFileContents | undefined>> {
  return scope !== null && snapshot.scope === scope ? snapshot.contentsByKey : {}
}

export function getMobilePrFileContentByteCount(contents: GitHubPRFileContents): number {
  return getUtf8ByteCount(contents.original) + getUtf8ByteCount(contents.modified)
}

function getUtf8ByteCount(value: string): number {
  let byteCount = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      byteCount += 1
    } else if (code < 0x800) {
      byteCount += 2
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        byteCount += 4
        index += 1
      } else {
        byteCount += 3
      }
    } else {
      byteCount += 3
    }
  }
  return byteCount
}
