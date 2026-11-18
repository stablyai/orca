import { useCallback, useEffect, useState } from 'react'
import { BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY } from '../../../../src/shared/browser/runtime/browser-runtime-capabilities'
import type { BrowserCertificateProceedFailureReason } from '../../../../src/shared/browser/workspaces/browser-workspace-types'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { startRuntimeCapabilityProbe } from '../../transport/connection/runtime-capability-probe'
import { isMobileMethodUnavailableError } from '../../transport/rpc/mobile-method-unavailable'
import { browserCertificateProceed } from '../page-interaction/mobile-browser-command-operations'

/** Why Proceed didn't go through: the host's reason, a lost request, or a host too old to take it from a phone. */
export type MobileCertificateProceedFailure =
  | BrowserCertificateProceedFailureReason
  | 'request-failed'
  | 'host-update-needed'

/** Desktop shows Proceed only when the host can trust a certificate; the phone follows the same capability. */
export function useBrowserCertificateTrustCapability(client: RpcClient | null): boolean {
  const [supported, setSupported] = useState(false)
  useEffect(() => {
    setSupported(false)
    if (!client) {
      return
    }
    return startRuntimeCapabilityProbe(client, (capabilities) => {
      setSupported(capabilities.includes(BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY))
    })
  }, [client])
  return supported
}

/** Accepts the host's certificate challenge for this page through the same host path desktop uses. */
export function useMobileBrowserCertificateProceed(
  client: RpcClient | null,
  worktreeId: string,
  browserPageId: string | null
): (challengeId: string) => Promise<MobileCertificateProceedFailure | null> {
  return useCallback(
    async (challengeId: string) => {
      if (!client || !browserPageId) {
        return 'missing'
      }
      try {
        const response = await browserCertificateProceed.request(
          client,
          { worktree: `id:${worktreeId}`, page: browserPageId, challengeId },
          { timeoutMs: 15_000 }
        )
        if (
          !response.ok &&
          isMobileMethodUnavailableError(response.error.code, response.error.message)
        ) {
          return 'host-update-needed'
        }
        const reply = browserCertificateProceed.interpret(response)
        if (reply.ok) {
          return null
        }
        return isProceedFailureReason(reply.reason) ? reply.reason : 'missing'
      } catch {
        return 'request-failed'
      }
    },
    [browserPageId, client, worktreeId]
  )
}

const PROCEED_FAILURE_REASONS: readonly string[] = [
  'expired',
  'changed',
  'ineligible',
  'missing',
  'navigated'
] satisfies readonly BrowserCertificateProceedFailureReason[]

function isProceedFailureReason(
  reason: string | undefined
): reason is BrowserCertificateProceedFailureReason {
  return reason !== undefined && PROCEED_FAILURE_REASONS.includes(reason)
}
