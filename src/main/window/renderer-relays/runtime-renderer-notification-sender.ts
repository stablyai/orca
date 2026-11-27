import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-list/feed/sidebar-inputs-switch'

export type RuntimeRendererGraphFailureReason =
  | 'renderer-frame-unavailable'
  | 'renderer-process-gone'

export function createRuntimeRendererNotificationSender(args: {
  isWindowDestroyed: () => boolean
  webContents: {
    isDestroyed: () => boolean
    send: (channel: string, ...args: unknown[]) => void
  }
  onFailure: (reason: RuntimeRendererGraphFailureReason) => void
  warn?: (message: string) => void
}): {
  send: (channel: string, ...values: unknown[]) => boolean
  onMainFrameReloadStarted: () => void
  onMainFrameReloadCancelled: () => void
  onMainFrameLoadFinished: () => void
  onRendererProcessGone: () => void
  close: () => void
} {
  let available = true
  let warningEmitted = false
  let closed = false
  const warn = args.warn ?? ((message: string) => console.warn(message))
  const suspend = (reason: RuntimeRendererGraphFailureReason): void => {
    if (closed || (!available && warningEmitted)) {
      return
    }
    available = false
    if (!warningEmitted) {
      warningEmitted = true
      warn(`[runtime-graph] Renderer notifications suspended: ${reason}`)
    }
    args.onFailure(reason)
  }

  return {
    send: (channel, ...values) => {
      if (closed || args.isWindowDestroyed() || args.webContents.isDestroyed() || !available) {
        return false
      }
      try {
        args.webContents.send(channel, ...values)
        return true
      } catch {
        // Renderer notification is secondary; disposed frames must not fail the originating persistence/runtime operation.
        suspend('renderer-frame-unavailable')
        return false
      }
    },
    onMainFrameReloadStarted: () => {
      if (closed) {
        return
      }
      available = false
      warningEmitted = false
    },
    onMainFrameReloadCancelled: () => {
      if (closed) {
        return
      }
      available = true
      warningEmitted = false
    },
    onMainFrameLoadFinished: () => {
      if (closed) {
        return
      }
      available = true
      warningEmitted = false
    },
    onRendererProcessGone: () => suspend('renderer-process-gone'),
    close: () => {
      closed = true
      available = false
    }
  }
}

export function forwardRuntimeClientNotice(
  send: (channel: string, payload: unknown) => boolean,
  event: RuntimeClientEvent
): void {
  if (event.type === 'linearLinkedIssueUpdated') {
    send('linear:linkedIssueUpdated', event)
  } else if (ORCA_SIDEBAR_INPUTS_IS_MAIN && event.type === 'sidebarInputsChanged') {
    send('runtime:sidebarInputsChanged', event)
  } else if (event.type === 'worktreeStartupDraftsChanged') {
    send('worktrees:startupDraftsChanged', event.drafts)
  }
}
