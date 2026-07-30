import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  isAiVaultPrepareSessionResumeUnavailableError,
  isLegacySharedCodexHome,
  isPerAccountManagedCodexHome
} from '../../../src/shared/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host'
import type { RpcClient } from '../transport/rpc-client'
import { t } from '@/i18n/mobile-i18n'

// Why: without an explicit timeout, a socket drop mid-resume parks the request
// on the reconnect waiter for the full reconnect budget, pinning the spinner.
export const RESUME_RPC_TIMEOUT_MS = 30_000

export async function prepareMobileAiVaultSessionResume(
  client: Pick<RpcClient, 'sendRequest'>,
  session: AiVaultSession
): Promise<AiVaultSession> {
  // Why: per-account repinning runs on the serving host, whose account
  // selection only applies to that host's own ("local") sessions.
  const needsAccountRepin =
    isPerAccountManagedCodexHome(session.codexHome) &&
    (!session.executionHostId || session.executionHostId === LOCAL_EXECUTION_HOST_ID)
  if (
    session.agent !== 'codex' ||
    (!isLegacySharedCodexHome(session.codexHome) && !needsAccountRepin)
  ) {
    return session
  }
  const response = await client.sendRequest(
    'aiVault.prepareSessionResume',
    {
      agent: session.agent,
      filePath: session.filePath,
      codexHome: session.codexHome,
      executionHostId: session.executionHostId
    },
    { timeoutMs: RESUME_RPC_TIMEOUT_MS }
  )
  if (!response.ok) {
    if (isAiVaultPrepareSessionResumeUnavailableError(response.error)) {
      // Why: older hosts cannot prepare, but their shared home still supports the legacy resume path.
      return session
    }
    throw new Error(response.error?.message || t('m.KEeLFyA'))
  }
  const result = response.result as {
    useRealCodexHome?: unknown
    substituteCodexHome?: unknown
  } | null
  if (result?.useRealCodexHome === true) {
    return { ...session, codexHome: null }
  }
  // Why: older hosts never send a repin home, so absence keeps the session's own home.
  if (typeof result?.substituteCodexHome === 'string' && result.substituteCodexHome) {
    return { ...session, codexHome: result.substituteCodexHome }
  }
  return session
}
