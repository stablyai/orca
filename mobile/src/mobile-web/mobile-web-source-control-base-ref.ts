import { MobileWebGitRefNameSchema } from '../../../src/shared/mobile-web/source-control-history-contract'
import type { RpcClient } from '../transport/rpc-client'

export async function resolveMobileWebSourceControlBaseRef(
  client: RpcClient,
  hostWorkspaceId: string
): Promise<string | null> {
  const worktreeBaseRef = await readWorktreeBaseRef(client, hostWorkspaceId)
  if (worktreeBaseRef) {
    return worktreeBaseRef
  }
  const repoId = hostWorkspaceId.split('::', 1)[0]?.trim()
  if (!repoId) {
    return null
  }
  const repoBaseRef = await readRepositoryBaseRef(client, repoId)
  if (repoBaseRef) {
    return repoBaseRef
  }
  try {
    const response = await client.sendRequest('repo.baseRefDefault', { repo: `id:${repoId}` })
    return response.ok && isRecord(response.result)
      ? safeBaseRef(response.result.defaultBaseRef)
      : null
  } catch {
    return null
  }
}

async function readWorktreeBaseRef(
  client: RpcClient,
  hostWorkspaceId: string
): Promise<string | null> {
  try {
    const response = await client.sendRequest('worktree.show', {
      worktree: `id:${hostWorkspaceId}`
    })
    return response.ok && isRecord(response.result) && isRecord(response.result.worktree)
      ? safeBaseRef(response.result.worktree.baseRef)
      : null
  } catch {
    return null
  }
}

async function readRepositoryBaseRef(client: RpcClient, repoId: string): Promise<string | null> {
  try {
    const response = await client.sendRequest('repo.list')
    if (!response.ok || !isRecord(response.result) || !Array.isArray(response.result.repos)) {
      return null
    }
    for (const candidate of response.result.repos) {
      if (isRecord(candidate) && candidate.id === repoId) {
        return safeBaseRef(candidate.worktreeBaseRef)
      }
    }
  } catch {
    return null
  }
  return null
}

function safeBaseRef(value: unknown): string | null {
  const parsed = MobileWebGitRefNameSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
