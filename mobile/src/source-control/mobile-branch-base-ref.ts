import { preferRemoteTrackingCompareBase } from '../../../src/shared/worktree/base-ref'
import type { RpcClient } from '../transport/rpc-client'
import { isMobileGitUnavailable } from './mobile-git-status'

type RuntimeRepoSummary = {
  id: string
  worktreeBaseRef?: string | null
}

type RuntimeWorktreeSummary = {
  baseRef?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getRepoIdFromMobileWorktreeId(id: string): string {
  const separatorIdx = id.indexOf('::')
  return separatorIdx === -1 ? id : id.slice(0, separatorIdx)
}

function readRepoSummaries(value: unknown): RuntimeRepoSummary[] {
  if (!isRecord(value) || !Array.isArray(value.repos)) {
    return []
  }
  return value.repos.flatMap((candidate): RuntimeRepoSummary[] => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string') {
      return []
    }
    return [
      {
        id: candidate.id,
        worktreeBaseRef:
          typeof candidate.worktreeBaseRef === 'string' ? candidate.worktreeBaseRef : null
      }
    ]
  })
}

function readDefaultBaseRef(value: unknown): string | null {
  if (!isRecord(value)) {
    return null
  }
  return typeof value.defaultBaseRef === 'string' ? value.defaultBaseRef.trim() || null : null
}

function readWorktreeSummary(value: unknown): RuntimeWorktreeSummary | null {
  if (!isRecord(value) || !isRecord(value.worktree)) {
    return null
  }
  return {
    baseRef: typeof value.worktree.baseRef === 'string' ? value.worktree.baseRef : null
  }
}

export async function resolveMobileBranchCompareBaseRef(
  client: RpcClient,
  worktreeId: string
): Promise<string | null> {
  const repoId = getRepoIdFromMobileWorktreeId(worktreeId)
  if (!repoId) {
    return null
  }

  const [worktreeResponse, repoResponse] = await Promise.all([
    client.sendRequest('worktree.show', { worktree: `id:${worktreeId}` }).catch(() => null),
    client.sendRequest('repo.list').catch(() => null)
  ])
  const worktreeBaseRef = worktreeResponse?.ok
    ? readWorktreeSummary(worktreeResponse.result)?.baseRef?.trim() || null
    : null
  const repo = repoResponse?.ok
    ? readRepoSummaries(repoResponse.result).find((candidate) => candidate.id === repoId)
    : undefined
  const repoBaseRef = repo?.worktreeBaseRef?.trim() || null
  let defaultBaseRef: string | null = null
  if (!repoBaseRef) {
    const defaultResponse = await client.sendRequest('repo.baseRefDefault', {
      repo: `id:${repoId}`
    })
    if (!defaultResponse.ok) {
      if (
        !isMobileGitUnavailable(defaultResponse.error?.code, defaultResponse.error?.message) &&
        !worktreeBaseRef
      ) {
        throw new Error(defaultResponse.error?.message || 'Unable to resolve branch base')
      }
    } else {
      defaultBaseRef = readDefaultBaseRef(defaultResponse.result)
    }
  }

  const repoOrDefault = repoBaseRef || defaultBaseRef
  return preferRemoteTrackingCompareBase(worktreeBaseRef, repoOrDefault)
}
