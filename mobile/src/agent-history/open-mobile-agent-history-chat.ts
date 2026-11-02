import { hostRouteWithNotice } from '../host-route-notice'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { StructuredSessionOpenFailure } from '../../../src/shared/open-structured-agent-session'
import type { RpcClient } from '../transport/rpc-client'
import {
  openMobileStructuredSession,
  mobileStructuredSessionHref
} from '../session/open-mobile-structured-session'

/** Consume native opens and ambiguous failures; only an explicit pre-effect refusal resumes in a terminal. */
export async function openMobileAgentHistoryChat(args: {
  client: RpcClient
  session: AiVaultSession
  hostId: string
  assertCurrentOwner: () => void
  opened: (href: string) => void
  failed: (reason: StructuredSessionOpenFailure['reason']) => void
}): Promise<boolean> {
  const { session, assertCurrentOwner } = args
  if (!session.structuredSession) {
    return false
  }
  const result = await openMobileStructuredSession({
    client: args.client,
    source: { kind: 'history', structuredSession: session.structuredSession, agent: session.agent },
    current: () => {
      try {
        assertCurrentOwner()
        return true
      } catch {
        return false
      }
    }
  })
  assertCurrentOwner()
  if (result.kind === 'opened') {
    args.opened(mobileStructuredSessionHref(args.hostId, result.target, result.tab))
  } else if (result.kind === 'failed' && result.failure.reason === 'workspace-missing') {
    args.opened(hostRouteWithNotice(args.hostId, 'worktree-missing'))
  } else if (
    result.kind === 'failed' &&
    result.failure.reason === 'unsupported' &&
    result.failure.beforeEffects
  ) {
    return false
  } else if (result.kind !== 'superseded') {
    args.failed(result.kind === 'failed' ? result.failure.reason : 'unknown')
  }
  return true
}
