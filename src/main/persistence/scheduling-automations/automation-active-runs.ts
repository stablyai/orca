// The runs not yet final, by the chat each runs into, read without walking the whole history each
// time: every mutation replaces the run array, so one pass per array serves every read until the next.
import {
  isFinalAutomationRunStatus,
  type AutomationRun
} from '../../../shared/automations/history/automation-run'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'

const activeByHistory = new WeakMap<
  readonly AutomationRun[],
  ReadonlyMap<string, AutomationRun[]>
>()

/** Retention never prunes a run that is not final, so these are all of them into the named chats. */
export function listActiveAutomationRunsInto(
  state: Pick<PersistedState, 'automationRuns'>,
  chatSessionIds: readonly string[]
): AutomationRun[] {
  const history = state.automationRuns ?? []
  let byChat = activeByHistory.get(history)
  if (!byChat) {
    const index = new Map<string, AutomationRun[]>()
    for (const run of history) {
      if (run.chatSessionId !== null && !isFinalAutomationRunStatus(run.status)) {
        index.set(run.chatSessionId, [...(index.get(run.chatSessionId) ?? []), run])
      }
    }
    byChat = index
    activeByHistory.set(history, byChat)
  }
  const index = byChat
  return chatSessionIds.flatMap((id) => index.get(id) ?? [])
}
