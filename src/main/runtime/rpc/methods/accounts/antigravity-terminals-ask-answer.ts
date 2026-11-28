import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { getAntigravityAccountService } from '../../../../antigravity/native-account-host'
import type {
  AntigravityAccountSelectResult,
  AntigravityAccountTarget
} from '../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import { withAntigravityChatBackend } from './antigravity-chat-backend'

/** Answers the Ask a switch to `accountId` left on the host's agy terminals. It selects nothing, so
 *  it can never undo a later switch. */
export async function answerAntigravityTerminalsAsk(
  runtime: OrcaRuntimeService,
  target: AntigravityAccountTarget,
  accountId: string,
  service: Awaited<ReturnType<typeof getAntigravityAccountService>>
): Promise<AntigravityAccountSelectResult> {
  const moved =
    target.runtime === 'host' ? await runtime.answerAntigravityAsk(accountId) : undefined
  return {
    ...(await withAntigravityChatBackend(runtime, target, await service.listAccounts())),
    ...(moved ? { runningSessions: moved } : {})
  }
}
