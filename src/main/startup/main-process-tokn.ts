import { registerToknHandlers } from '../ipc/tokn'
import { createToknUsageReader } from '../tokn/tokn-upload-body'
import { mainProcessState as state } from './main-process-state'

export function initializeMainProcessTokn(): void {
  // Publishing is set up from the desktop Stats pane; a headless server never shows it.
  if (state.isServeMode) {
    return
  }
  const backend = state.backend
  if (!backend) {
    throw new Error('The usage backend must start before tokn publishing')
  }
  registerToknHandlers(
    createToknUsageReader((method, params, explicit) =>
      backend.callPrivileged(method, params, explicit)
    )
  )
}
