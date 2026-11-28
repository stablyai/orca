import type { OrcaRuntimeService } from '../../orca-runtime'
import { isHostShuttingDown } from '../../../startup/quit/host-shutdown-state'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'

type ServingRuntime = Pick<
  OrcaRuntimeService,
  'openAgentSessionRecordStore' | 'startPullRequestWatches'
>

function startOldChatHistoryCleanup(runtime: ServingRuntime): void {
  void runtime.openAgentSessionRecordStore().catch((error: unknown) => {
    createStructuredAgentSessionLogger().error(
      'old chat journal: not checked (chat store failed to open)',
      {
        scope: 'old-chat-history-cleanup-open',
        error
      }
    )
  })
}

export function agentSessionRecordStoreHostServing(runtime: ServingRuntime): void {
  if (isHostShuttingDown()) {
    return
  }
  startOldChatHistoryCleanup(runtime)
  runtime.startPullRequestWatches({ admit: true })
  // Desktop and headless hosts both serve through here; a naming home a crash or a failed removal
  // left may hold a copy of the agent's login, whatever the naming settings now say.
  void import('../../../acp/text-task/acp-text-task-homes-at-launch')
    .then(({ sweepAcpTextTaskHomesAtLaunch }) => sweepAcpTextTaskHomesAtLaunch())
    .catch((error: unknown) => console.warn('[acp-text-task] Launch sweep failed:', error))
}
