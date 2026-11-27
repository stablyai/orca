import { isNativeLocalLocation } from '../../../../shared/execution-host/execution-host'
import type { StructuredAgentSessionHistoryRefreshInput } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-history-refresh-input'
import type { StructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { catchUpCodexThread } from '../threads/codex-structured-thread-catch-up'
import {
  runCodexProviderAppServer,
  type CodexProviderInvocationDeps
} from './codex-provider-session-rename'

export async function refreshCodexSessionHistory(
  input: StructuredAgentSessionHistoryRefreshInput,
  invocation: CodexProviderInvocationDeps | undefined,
  logger?: StructuredAgentSessionLogger
): Promise<void> {
  if (!invocation || !isNativeLocalLocation(input.record.location)) {
    input.onSkipped('unsupported')
    return
  }
  input.assertCurrent()
  await runCodexProviderAppServer(
    input.record,
    {
      ...invocation,
      resolveLaunchArgs: () => input.record.launchArgs ?? invocation.resolveLaunchArgs()
    },
    { timeoutMs: 15_000, experimentalApi: true, signal: input.signal },
    (rpc) =>
      catchUpCodexThread({
        connection: rpc,
        threadId: input.providerSessionId,
        sessionId: input.record.sessionId,
        sink: input.sink,
        signal: rpc.signal,
        onSkipped: input.onSkipped,
        assertCurrent: input.assertCurrent,
        timeoutMs: 15_000,
        logger
      })
  )
}
