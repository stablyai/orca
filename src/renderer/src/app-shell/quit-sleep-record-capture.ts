import type { AppState } from '../store/types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { changedSleepingRecords } from '../store/terminals/terminal-sleep-layout-owner'

/**
 * A layout-owner build's quit capture: the resume records it changed of tabs the window holds,
 * since the last stage that carried them, so a stage retried after a failed one still sends the
 * first capture's records.
 */
export function createQuitSleepRecordCapture(store: { getState: () => AppState }): {
  capture: () => SleepingAgentSessionRecord[]
  staged: () => void
} {
  let unstagedSince: AppState['sleepingAgentSessionsByPaneKey'] | null = null
  return {
    capture: () => {
      const previous = unstagedSince ?? store.getState().sleepingAgentSessionsByPaneKey
      unstagedSince = previous
      store.getState().captureAllSleepingAgentSessions('quit')
      const state = store.getState()
      return changedSleepingRecords(state, previous, state.sleepingAgentSessionsByPaneKey).recorded
    },
    staged: () => {
      unstagedSince = null
    }
  }
}
