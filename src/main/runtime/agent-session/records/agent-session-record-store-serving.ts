import type { OrcaRuntimeService } from '../../orca-runtime'
import { isHostShuttingDown } from '../../../startup/quit/host-shutdown-state'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'

type ServingRuntime = Pick<
  OrcaRuntimeService,
  'openAgentSessionRecordStore' | 'startPullRequestWatches'
>

function startOldChatHistoryCleanup(runtime: ServingRuntime): void {
  void runtime.openAgentSessionRecordStore().catch((error: unknown) => {
    createStructuredAgentSessionLogger().error('old chat journal: deferred (reason open_failed)', {
      scope: 'old-chat-history-cleanup-open',
      error
    })
  })
}

export function agentSessionRecordStoreHostServing(runtime: ServingRuntime): void {
  if (isHostShuttingDown()) {
    return
  }
  startOldChatHistoryCleanup(runtime)
  runtime.startPullRequestWatches({ admit: true })
}
