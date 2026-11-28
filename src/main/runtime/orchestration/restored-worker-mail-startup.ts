import type { OrcaRuntimeService } from '../orca-runtime'
import type { agentQuestionNotices } from '../rpc/methods/orchestration/messaging/agent-question-notices'
import type { OrchestrationDb } from './db/orchestration-db'

type AgentQuestionNoticeArgs = Parameters<typeof agentQuestionNotices>

export function startRestoredWorkerMailLazy(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  isCurrent: () => boolean
): void {
  void import('../rpc/methods/orchestration/messaging/settled-worker-follow-through')
    .then(({ continueRestoredWorkerMailSoon }) => {
      if (isCurrent()) {
        continueRestoredWorkerMailSoon(runtime, db, isCurrent)
      }
    })
    .catch((error) => console.warn('[orchestration] Restored worker mail startup failed:', error))
}

export async function notifyAgentQuestionLazy(
  runtime: OrcaRuntimeService,
  taker: AgentQuestionNoticeArgs[1],
  ids: AgentQuestionNoticeArgs[2],
  chat: AgentQuestionNoticeArgs[3]
): ReturnType<typeof agentQuestionNotices> {
  const { agentQuestionNotices: notify } =
    await import('../rpc/methods/orchestration/messaging/agent-question-notices')
  return notify(runtime, taker, ids, chat)
}
