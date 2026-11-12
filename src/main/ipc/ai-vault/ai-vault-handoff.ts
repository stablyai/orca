import { isUnresolvedOwnerHostId, parseExecutionHostId } from '../../../shared/execution-host'
import {
  AI_VAULT_SESSION_HANDOFF_TIMEOUT_MS,
  readAiVaultSessionHandoffResult,
  type AiVaultSessionHandoffArgs,
  type AiVaultSessionHandoffResult
} from '../../../shared/ai-vault/contracts/ai-vault-session-handoff'
import { writeAiVaultSessionHandoffSnapshot } from '../../ai-vault/session-handoff-snapshot'
import { callRuntimeEnvironment } from '../runtime-environments/runtime-environment-transport-routing'
import { getRuntimeEnvironmentRegistryRoot } from '../runtime-environments/runtime-environment-registry-root'

/** The snapshot is written on the session's own host, where the hand-off agent starts. */
export async function prepareAiVaultSessionHandoff(
  args: AiVaultSessionHandoffArgs
): Promise<AiVaultSessionHandoffResult> {
  const host = parseExecutionHostId(args.executionHostId)
  if (host?.kind === 'ssh') {
    return {}
  }
  if (host?.kind !== 'runtime') {
    return writeAiVaultSessionHandoffSnapshot(args)
  }
  if (isUnresolvedOwnerHostId(host.id)) {
    return {}
  }
  // An older host answers method_not_found; any failure leaves the preview hand-off.
  const response = await callRuntimeEnvironment(
    getRuntimeEnvironmentRegistryRoot(),
    host.environmentId,
    'aiVault.prepareSessionHandoff',
    { agent: args.agent, filePath: args.filePath, sessionId: args.sessionId },
    AI_VAULT_SESSION_HANDOFF_TIMEOUT_MS
  ).catch(() => null)
  return readAiVaultSessionHandoffResult(response?.ok === true ? response.result : null)
}
