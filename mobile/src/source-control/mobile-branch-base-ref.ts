import type { RpcClient } from '../transport/rpc-client'
import { isMobileGitUnavailable } from './mobile-git-status'

type RuntimeRepoSummary = {
  id: string
  worktreeBaseRef?: string | null
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

export async function resolveMobileBranchCompareBaseRef(
  client: RpcClient,
  worktreeId: string
): Promise<string | null> {
  const repoId = getRepoIdFromMobileWorktreeId(worktreeId)
  if (!repoId) {
    return null
  }

  let repoBaseRef: string | null = null
  const repoResponse = await client.sendRequest('repo.list')
  if (repoResponse.ok) {
    const repo = readRepoSummaries(repoResponse.result).find((candidate) => candidate.id === repoId)
    repoBaseRef = repo?.worktreeBaseRef?.trim() || null
  }

  if (repoBaseRef) {
    return repoBaseRef
  }

  const defaultResponse = await client.sendRequest('repo.baseRefDefault', { repo: `id:${repoId}` })
  if (!defaultResponse.ok) {
    if (isMobileGitUnavailable(defaultResponse.error?.code, defaultResponse.error?.message)) {
      return null
    }
    throw new Error(defaultResponse.error?.message || 'Unable to resolve branch base')
  }
  return readDefaultBaseRef(defaultResponse.result)
}
