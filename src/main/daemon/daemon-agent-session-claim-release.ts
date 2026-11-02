import {
  isAgentSessionClaimReleaseOutcome,
  type AgentSessionClaimReleaseOutcome,
  type AgentSessionClaimReleaseRequest
} from '../../shared/agent-session-claim-release'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import type { DaemonClient } from './client'
import type { DaemonSessionOwnerResolution } from './daemon-session-owner-resolution'

const UNVERIFIABLE: AgentSessionClaimReleaseOutcome = { outcome: 'refused', reason: 'unverifiable' }

/** One bounded request; a lost or malformed reply is never treated as a release. */
export async function requestDaemonAgentSessionClaimRelease(
  client: DaemonClient,
  request: AgentSessionClaimReleaseRequest,
  timeoutMs: number
): Promise<AgentSessionClaimReleaseOutcome> {
  if (timeoutMs <= 0) {
    return UNVERIFIABLE
  }
  try {
    const result = await client.request<unknown>(
      'releaseAgentSessionClaim',
      {
        sessionId: request.id,
        expectedIncarnationId: request.expectedIncarnationId,
        owner: request.owner
      },
      timeoutMs
    )
    return isAgentSessionClaimReleaseOutcome(result) ? result : UNVERIFIABLE
  } catch {
    return UNVERIFIABLE
  }
}

/** Routes a release to the daemon generation that owns this exact incarnation. */
export async function releaseResolvedDaemonAgentSessionClaim(
  request: AgentSessionClaimReleaseRequest,
  timeoutMs: number,
  resolve: () => Promise<DaemonSessionOwnerResolution<IPtyProvider> | { kind: 'replaced' }>
): Promise<AgentSessionClaimReleaseOutcome> {
  try {
    const resolution = await resolve()
    if (resolution.kind === 'replaced') {
      return { outcome: 'refused', reason: 'replaced' }
    }
    if (
      resolution.kind !== 'owner' ||
      !resolution.provider.supportsAgentSessionClaimRelease?.(request.id) ||
      !resolution.provider.releaseAgentSessionClaim
    ) {
      return { outcome: 'refused', reason: 'unsupported' }
    }
    return await resolution.provider.releaseAgentSessionClaim(request, timeoutMs)
  } catch {
    return UNVERIFIABLE
  }
}

/** The release capability of whichever verified daemon generation owns a PTY. */
export function routedDaemonAgentSessionClaimRelease(
  route: (id: string) => IPtyProvider | null | undefined,
  resolve: (
    id: string,
    incarnationId: string
  ) => Promise<DaemonSessionOwnerResolution<IPtyProvider> | { kind: 'replaced' }>
): Required<Pick<IPtyProvider, 'supportsAgentSessionClaimRelease' | 'releaseAgentSessionClaim'>> {
  return {
    supportsAgentSessionClaimRelease: (id) =>
      route(id)?.supportsAgentSessionClaimRelease?.(id) === true,
    releaseAgentSessionClaim: (request, timeoutMs) =>
      releaseResolvedDaemonAgentSessionClaim(request, timeoutMs, () =>
        resolve(request.id, request.expectedIncarnationId)
      )
  }
}
