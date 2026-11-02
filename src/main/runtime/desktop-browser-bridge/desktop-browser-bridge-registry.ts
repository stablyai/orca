/**
 * orcad's side of the desktop browser bridge: the desktops attached to it and the forwarded
 * requests waiting on their answers. The newest attachment serves; an older one takes over only
 * when the newer one detaches.
 */
import { randomUUID } from 'node:crypto'
import { BrowserError } from '../../browser/browser-error'
import {
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_MESSAGE,
  type DesktopBrowserBridgeEvent,
  type DesktopBrowserBridgeResultParams
} from '../../../shared/desktop-browser-bridge-protocol'

// Why below 32: the desktop answers over one subscription that holds at most 32 unacknowledged
// requests (remote-runtime-subscription-request-channel), so more would strand finished results.
export const MAX_PENDING_PER_ATTACHMENT = 16
const DESKTOP_DEADLINE_MARGIN_MS = 10_000
const MIN_DESKTOP_DEADLINE_MS = 1_000

type Attachment = {
  attachmentId: string
  connectionId: string
  pairedDeviceId: string
  emit: (event: DesktopBrowserBridgeEvent) => void
}

type PendingRequest = {
  attachmentId: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type DesktopBrowserBridgeForward = {
  method: string
  params: Record<string, unknown>
  workspaceId?: string
}

export class DesktopBrowserBridgeRegistry {
  private readonly attachments: Attachment[] = []
  private readonly pending = new Map<string, PendingRequest>()

  attach(input: Omit<Attachment, 'attachmentId'>): { attachmentId: string; detach(): void } {
    const attachment: Attachment = { ...input, attachmentId: randomUUID() }
    this.attachments.push(attachment)
    return {
      attachmentId: attachment.attachmentId,
      detach: () => this.detach(attachment.attachmentId)
    }
  }

  hasAttachment(): boolean {
    return this.attachments.length > 0
  }

  forward(
    request: DesktopBrowserBridgeForward,
    options: { timeoutMs: number; signal?: AbortSignal }
  ): Promise<unknown> {
    const attachment = this.attachments.at(-1)
    if (!attachment) {
      return Promise.reject(unavailableError())
    }
    if (this.pendingCount(attachment.attachmentId) >= MAX_PENDING_PER_ATTACHMENT) {
      return Promise.reject(
        new BrowserError('browser_busy', 'Too many browser commands are waiting on the desktop.')
      )
    }
    const requestId = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        settle()
        reject(new BrowserError('browser_aborted', 'The browser command was cancelled.'))
      }
      const timer = setTimeout(() => {
        settle()
        reject(
          new BrowserError('browser_timeout', 'The desktop did not answer the browser command.')
        )
      }, options.timeoutMs)
      this.pending.set(requestId, {
        attachmentId: attachment.attachmentId,
        resolve: (value) => {
          settle()
          resolve(value)
        },
        reject: (error) => {
          settle()
          reject(error)
        },
        timer
      })
      if (options.signal?.aborted) {
        onAbort()
        return
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        attachment.emit({
          type: 'request',
          requestId,
          method: request.method,
          params: request.params,
          // Why shorter: the desktop must stop starting this before orcad gives up, transit included.
          timeoutMs: Math.max(
            MIN_DESKTOP_DEADLINE_MS,
            options.timeoutMs - DESKTOP_DEADLINE_MARGIN_MS
          ),
          ...(request.workspaceId ? { workspaceId: request.workspaceId } : {})
        })
      } catch {
        this.pending.get(requestId)?.reject(unavailableError())
      }
    })
  }

  /** Accepts an answer only from the socket and device the request was sent to. */
  settle(
    caller: { connectionId: string; pairedDeviceId: string },
    result: DesktopBrowserBridgeResultParams
  ): boolean {
    const pending = this.pending.get(result.requestId)
    const attachment = this.attachments.find((entry) => entry.attachmentId === result.attachmentId)
    if (
      !pending ||
      !attachment ||
      pending.attachmentId !== attachment.attachmentId ||
      attachment.connectionId !== caller.connectionId ||
      attachment.pairedDeviceId !== caller.pairedDeviceId
    ) {
      return false
    }
    if (result.ok) {
      pending.resolve(result.result)
    } else {
      pending.reject(new BrowserError(result.error.code, result.error.message))
    }
    return true
  }

  private detach(attachmentId: string): void {
    const index = this.attachments.findIndex((entry) => entry.attachmentId === attachmentId)
    if (index === -1) {
      return
    }
    this.attachments.splice(index, 1)
    for (const pending of this.pending.values()) {
      if (pending.attachmentId === attachmentId) {
        pending.reject(
          new BrowserError(
            DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
            'The Orca desktop stopped sharing its browser before it answered.'
          )
        )
      }
    }
  }

  private pendingCount(attachmentId: string): number {
    let count = 0
    for (const pending of this.pending.values()) {
      if (pending.attachmentId === attachmentId) {
        count += 1
      }
    }
    return count
  }
}

function unavailableError(): BrowserError {
  return new BrowserError(
    DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
    DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_MESSAGE
  )
}

const registries = new WeakMap<object, DesktopBrowserBridgeRegistry>()
let hostEnabled = false

/** Only orcad serves the bridge; a desktop runtime never accepts an attach or forwards a call. */
export function setDesktopBrowserBridgeHostEnabled(enabled: boolean): void {
  hostEnabled = enabled
}

export function isDesktopBrowserBridgeHostEnabled(): boolean {
  return hostEnabled
}

export function getDesktopBrowserBridgeRegistry(runtime: {
  getRuntimeId(): string
}): DesktopBrowserBridgeRegistry {
  let registry = registries.get(runtime)
  if (!registry) {
    registry = new DesktopBrowserBridgeRegistry()
    registries.set(runtime, registry)
  }
  return registry
}
