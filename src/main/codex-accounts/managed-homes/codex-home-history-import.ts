import { copyProfileHistory } from '../../providers/accounts/profile-history-import'
import { parseCodexRolloutThreadId } from '../../codex/history/rollouts/codex-rollout-thread-id'

export async function importCodexHomeHistory(
  sourceHome: string,
  destinationHome: string
): Promise<Map<string, string>> {
  const threads = new Map<string, string>()
  await copyProfileHistory(
    sourceHome,
    destinationHome,
    ['sessions', 'archived_sessions', 'session_index.jsonl', 'history.jsonl'],
    (file) => {
      const rollout = parseCodexRolloutThreadId(file)
      if (rollout && (threads.get(rollout.threadId) ?? '') < rollout.rolloutStamp) {
        threads.set(rollout.threadId, rollout.rolloutStamp)
      }
    }
  )
  return threads
}
