import { useCallback, useEffect, useState } from 'react'
import type { GitHubPRFileContents, GitHubRepositoryIdentity } from '../../../src/shared/types'
import {
  MobilePrFileContentCache,
  createMobilePrFileContentKey,
  createMobilePrFileContentScope,
  getMobilePrFileContentsForScope,
  type MobilePrFileContentKeyInput
} from './mobile-pr-file-content-cache'

type MobilePrScopeTaskItem = {
  provider: string
  source: unknown
} | null

type MobilePrScopeDetail = {
  provider: string
  headSha?: unknown
  baseSha?: unknown
} | null

type MobileProjectPrScopeItem = {
  itemType: string
  content: { number?: unknown }
} | null

type MobileProjectPrScopeRepo = { id?: unknown } | null

type MobilePrFileContentLoad = () => Promise<unknown>
type MobilePrFileContentErrorSetter = (message: string) => void

export function createMobileItemPrFileContentScope(
  item: MobilePrScopeTaskItem,
  detail: MobilePrScopeDetail
): string | null {
  const source =
    item?.source && typeof item.source === 'object'
      ? (item.source as { type?: unknown; repoId?: unknown; number?: unknown })
      : null
  if (
    item?.provider !== 'github' ||
    source?.type !== 'pr' ||
    typeof source.repoId !== 'string' ||
    typeof source.number !== 'number' ||
    detail?.provider !== 'github' ||
    typeof detail.headSha !== 'string' ||
    !detail.headSha ||
    typeof detail.baseSha !== 'string' ||
    !detail.baseSha
  ) {
    return null
  }
  return createMobilePrFileContentScope({
    source: 'item',
    repoId: source.repoId,
    prNumber: source.number,
    headSha: detail.headSha,
    baseSha: detail.baseSha
  })
}

export function createMobileProjectPrFileContentScope(
  item: MobileProjectPrScopeItem,
  repo: MobileProjectPrScopeRepo,
  detail: MobilePrScopeDetail,
  repository?: GitHubRepositoryIdentity | null
): string | null {
  if (
    item?.itemType !== 'PULL_REQUEST' ||
    typeof item.content.number !== 'number' ||
    typeof repo?.id !== 'string' ||
    detail?.provider !== 'github' ||
    typeof detail.headSha !== 'string' ||
    !detail.headSha ||
    typeof detail.baseSha !== 'string' ||
    !detail.baseSha
  ) {
    return null
  }
  return createMobilePrFileContentScope({
    source: 'project',
    repoId: repo.id,
    prNumber: item.content.number,
    repository,
    headSha: detail.headSha,
    baseSha: detail.baseSha
  })
}

export function useMobilePrFileContentCache(activeScope: string | null): {
  clear: () => void
  contents: Readonly<Record<string, GitHubPRFileContents | undefined>>
  load: (
    scope: string,
    file: MobilePrFileContentKeyInput,
    loadContents: MobilePrFileContentLoad,
    setError: MobilePrFileContentErrorSetter
  ) => Promise<void>
  loadingPath: string | null
} {
  const [cache] = useState(() => new MobilePrFileContentCache())
  const [snapshot, setSnapshot] = useState(() => cache.snapshot())
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const clear = useCallback(() => {
    cache.clear()
    setSnapshot(cache.snapshot())
    setLoadingPath(null)
  }, [cache])

  useEffect(() => {
    if (activeScope === null) {
      clear()
    } else if (cache.activateScope(activeScope)) {
      setSnapshot(cache.snapshot())
      setLoadingPath(null)
    }
  }, [activeScope, cache, clear])

  const load = useCallback(
    async (
      scope: string,
      file: MobilePrFileContentKeyInput,
      loadContents: MobilePrFileContentLoad,
      setError: MobilePrFileContentErrorSetter
    ): Promise<void> => {
      const key = createMobilePrFileContentKey(file)
      const selection = cache.select(scope, key)
      if (selection.scopeChanged) {
        setSnapshot(cache.snapshot())
      }
      if (selection.contents) {
        setLoadingPath(null)
        return
      }
      const token = cache.beginRequest(scope, key)
      setLoadingPath(file.path)
      setError('')
      try {
        const result = await loadContents()
        if (!isGitHubPrFileContents(result)) {
          throw new Error('Invalid file contents response')
        }
        const commit = cache.commitRequest(token, result)
        if (commit === 'stale') {
          return
        }
        if (commit === 'too-large') {
          setError('File too large for mobile preview.')
        } else {
          setSnapshot(cache.snapshot())
        }
        setLoadingPath((current) => (current === file.path ? null : current))
      } catch (error) {
        if (!cache.rejectRequest(token)) {
          return
        }
        setError(error instanceof Error ? error.message : 'Failed to load file contents')
        setLoadingPath((current) => (current === file.path ? null : current))
      }
    },
    [cache]
  )

  return {
    clear,
    contents: getMobilePrFileContentsForScope(snapshot, activeScope),
    load,
    loadingPath
  }
}

function isGitHubPrFileContents(value: unknown): value is GitHubPRFileContents {
  if (!value || typeof value !== 'object') {
    return false
  }
  const contents = value as Partial<GitHubPRFileContents>
  return (
    typeof contents.original === 'string' &&
    typeof contents.modified === 'string' &&
    typeof contents.originalIsBinary === 'boolean' &&
    typeof contents.modifiedIsBinary === 'boolean'
  )
}
