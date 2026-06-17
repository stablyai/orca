import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'

// Link / unlink an existing PR to the current worktree via worktree.set (the same
// path desktop's "Link another PR" uses). GitHub-scoped: it writes the worktree's
// `linkedPR` key, matching desktop where linking is GitHub-only (GitLab/Bitbucket
// use separate linked* keys). linkedPR is tri-state on the host: a number sets the
// link, null clears it. worktree.set is allowlisted for mobile.

export type MobilePrLinkOutcome = { ok: true } | { ok: false; error: string }

// Pure param builder (unit-tested): the worktree selector + tri-state linkedPR.
export function buildWorktreeSetLinkParams(
  worktreeId: string,
  linkedPR: number | null
): Record<string, unknown> {
  return { worktree: `id:${worktreeId}`, linkedPR }
}

async function setLinkedPr(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  linkedPR: number | null
): Promise<MobilePrLinkOutcome> {
  try {
    const response = await client.sendRequest(
      'worktree.set',
      buildWorktreeSetLinkParams(worktreeId, linkedPR)
    )
    if (!response.ok) {
      return { ok: false, error: response.error?.message || 'Failed to update linked pull request' }
    }
    return { ok: true }
  } catch (err) {
    // Why: a transport drop must not escape as an unhandled rejection — normalize
    // to the `{ ok:false, error }` outcome the link flow surfaces.
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to update linked pull request'
    }
  }
}

export function linkMobilePr(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  prNumber: number
): Promise<MobilePrLinkOutcome> {
  return setLinkedPr(client, worktreeId, prNumber)
}

export function unlinkMobilePr(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string
): Promise<MobilePrLinkOutcome> {
  return setLinkedPr(client, worktreeId, null)
}

// Reads the worktree's persisted linkedPR (via worktree.show) so the sidebar can
// surface a linked PR even when it's closed/merged and the branch-based lookup
// returns nothing. Returns null when unset or on any read failure.
export async function fetchWorktreeLinkedPR(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string
): Promise<number | null> {
  try {
    const response = await client.sendRequest('worktree.show', { worktree: `id:${worktreeId}` })
    if (!response.ok) {
      return null
    }
    const result = (response as RpcSuccess).result as { worktree?: { linkedPR?: number | null } }
    const linked = result?.worktree?.linkedPR
    return typeof linked === 'number' ? linked : null
  } catch {
    // Why: a fallback read — a transport drop is non-fatal, fall back to "no link".
    return null
  }
}
