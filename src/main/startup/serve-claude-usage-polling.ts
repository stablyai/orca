import { createClaudeUsagePollingSwitch } from '../claude-accounts/claude-usage-polling-policy'
import { mainProcessState as state } from './main-process-state'

function publishServePolling(on: boolean): void {
  console.info(
    `[claude-usage] polling switch: mode=serve pollInactive=${on} pollWithoutWindow=${on}`
  )
}

/** Arms the headless usage poll once. A later serve window must not start the desktop poll over it. */
export function armServeClaudeUsagePolling(): boolean {
  if (state.stopClaudeUsagePolling) {
    return false
  }
  const rateLimits = state.rateLimits
  const store = state.store
  if (!rateLimits || !store) {
    console.info('[claude-usage] inactive fetch skipped reason=not-attached')
    return false
  }
  const polling = createClaudeUsagePollingSwitch(rateLimits, () => store.getSettings())
  let on = polling.apply()
  publishServePolling(on)
  const unsubscribe = store.onSettingsChanged((updates) => {
    const next = polling.apply(updates)
    if (next !== on) {
      on = next
      publishServePolling(on)
    }
  })
  const stop = (): void => {
    if (state.stopClaudeUsagePolling !== stop) {
      return
    }
    unsubscribe()
    state.stopClaudeUsagePolling = null
  }
  state.stopClaudeUsagePolling = stop
  return true
}
