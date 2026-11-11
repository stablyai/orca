import { eventField } from './local-command-request-checks'

const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 60_000

export type LocalCommandSubscription = { close: () => void }

export type LocalCommandTimer = (run: () => void, ms: number) => { cancel: () => void }

export const defaultLocalCommandTimer: LocalCommandTimer = (run, ms) => {
  const handle = setTimeout(run, ms)
  handle.unref?.()
  return { cancel: () => clearTimeout(handle) }
}

type Attachment = {
  environmentId: string
  subscription: LocalCommandSubscription | null
  connected: boolean
  retryMs: number
  retry: { cancel: () => void } | null
  closed: boolean
}

export type LocalCommandAttachmentsDeps = {
  subscribe: (
    environmentId: string,
    onEvent: (event: unknown) => void,
    onClose: () => void
  ) => Promise<LocalCommandSubscription>
  setTimer: LocalCommandTimer
  onEvent: (sandboxId: string, environmentId: string, event: unknown) => void
  onConnectedChanged: () => void
}

/**
 * One attach stream per turned-on workspace, keyed by sandbox id (a rollover changes the
 * environment id; consent stays with the workspace). A closed stream retries with backoff.
 */
export function createLocalCommandAttachments(deps: LocalCommandAttachmentsDeps) {
  const attachments = new Map<string, Attachment>()

  function setConnected(attachment: Attachment, connected: boolean): void {
    if (attachment.connected !== connected) {
      attachment.connected = connected
      deps.onConnectedChanged()
    }
  }

  function attach(sandboxId: string, environmentId: string): void {
    const attachment: Attachment = {
      environmentId,
      subscription: null,
      connected: false,
      retryMs: RETRY_MIN_MS,
      retry: null,
      closed: false
    }
    attachments.set(sandboxId, attachment)
    const onClose = (): void => {
      attachment.subscription = null
      setConnected(attachment, false)
      if (!attachment.closed && !attachment.retry) {
        attachment.retry = deps.setTimer(open, attachment.retryMs)
        attachment.retryMs = Math.min(attachment.retryMs * 2, RETRY_MAX_MS)
      }
    }
    const onEvent = (event: unknown): void => {
      if (attachment.closed) {
        return
      }
      const type = eventField(event, 'type')
      if (type === 'ready') {
        attachment.retryMs = RETRY_MIN_MS
        setConnected(attachment, true)
        return
      }
      deps.onEvent(sandboxId, environmentId, event)
    }
    function open(): void {
      attachment.retry = null
      if (attachment.closed) {
        return
      }
      deps.subscribe(environmentId, onEvent, onClose).then(
        (subscription) => {
          if (attachment.closed) {
            subscription.close()
            return
          }
          attachment.subscription = subscription
        },
        () => onClose()
      )
    }
    open()
  }

  function detach(sandboxId: string): void {
    const attachment = attachments.get(sandboxId)
    if (!attachment) {
      return
    }
    attachment.closed = true
    attachment.retry?.cancel()
    attachment.subscription?.close()
    attachments.delete(sandboxId)
  }

  return {
    /** Attach to exactly these workspaces (sandbox id → environment id). */
    reconcile(desired: ReadonlyMap<string, string>): void {
      for (const [sandboxId, attachment] of attachments) {
        if (desired.get(sandboxId) !== attachment.environmentId) {
          detach(sandboxId)
        }
      }
      for (const [sandboxId, environmentId] of desired) {
        if (!attachments.has(sandboxId)) {
          attach(sandboxId, environmentId)
        }
      }
    },
    isConnected(sandboxId: string): boolean {
      return attachments.get(sandboxId)?.connected === true
    },
    dispose(): void {
      for (const sandboxId of attachments.keys()) {
        detach(sandboxId)
      }
    }
  }
}
