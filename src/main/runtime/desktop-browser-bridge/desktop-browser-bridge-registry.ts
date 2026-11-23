/** orcad forwards through its newest desktop attachment; older ones resume only after it detaches. */
import { randomUUID } from 'node:crypto'
import { BrowserError } from '../../browser/browser-error'
import {
  DESKTOP_BROWSER_BRIDGE_METHOD_CAPABILITIES,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_MESSAGE,
  type DesktopBrowserBridgeEvent,
  type DesktopBrowserBridgeResultChunkParams,
  type DesktopBrowserBridgeResultParams
} from '../../../shared/browser/client-hosting/desktop-browser-bridge-protocol'
import { BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES } from '../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { StagedResultChunks } from '../browser-host/commands/staged-result-chunks'
import type {
  DesktopBrowserBridgeDownloadAbortParams,
  DesktopBrowserBridgeDownloadWriteParams,
  DesktopBrowserBridgeFileReadParams
} from '../../../shared/browser/client-hosting/desktop-browser-bridge-file-transfer-protocol'
import { readLocalFileRange } from '../../filesystem/local-file-io/local-file-range-read'
import { DesktopBrowserBridgeHostDownloads } from './desktop-browser-bridge-host-downloads'

// Stay below the subscription's 32-unacknowledged-request bound or completed results could strand.
export const MAX_PENDING_PER_ATTACHMENT = 16
const DESKTOP_DEADLINE_MARGIN_MS = 10_000
const MIN_DESKTOP_DEADLINE_MS = 1_000
// Several commands can stage large results at once; bound their total, as page leases do.
const MAX_STAGED_RESULT_BYTES = 2 * BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES

type Attachment = {
  attachmentId: string
  connectionId: string
  pairedDeviceId: string
  acceptsCancel?: boolean
  enforcesExpectUrl?: boolean
  capabilities?: readonly string[]
  emit: (event: DesktopBrowserBridgeEvent) => void
}

type PendingRequest = {
  attachmentId: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  readablePaths?: ReadonlySet<string>
}

export type DesktopBrowserBridgeForward = {
  method: string
  params: Record<string, unknown>
  workspaceId?: string
  /** Files on this host the desktop may read while it answers: exactly those an upload named. */
  readablePaths?: readonly string[]
  /** Where on this host to save the download the command starts. */
  downloadPath?: string
}

type Caller = { connectionId: string; pairedDeviceId: string }

export class DesktopBrowserBridgeRegistry {
  private readonly attachments: Attachment[] = []
  private readonly pending = new Map<string, PendingRequest>()
  private readonly stagedResults = new StagedResultChunks<string>(MAX_STAGED_RESULT_BYTES)
  private readonly downloads = new DesktopBrowserBridgeHostDownloads()

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

  /** Commands go to the newest attachment only, so an older one behind it can't help. */
  newestAttachmentEnforcesExpectUrl(): boolean {
    return this.attachments.at(-1)?.enforcesExpectUrl === true
  }

  newestAttachmentServes(method: string): boolean {
    const required = DESKTOP_BROWSER_BRIDGE_METHOD_CAPABILITIES.get(method)
    return !required || this.newestAttachmentDeclares(required)
  }

  newestAttachmentDeclares(capability: string): boolean {
    return this.attachments.at(-1)?.capabilities?.includes(capability) ?? false
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
    if (request.downloadPath === undefined) {
      return this.forwardTo(attachment, request, options)
    }
    return this.downloads.forward(attachment.attachmentId, request.downloadPath, (transferId) =>
      this.forwardTo(attachment, { ...request, params: { ...request.params, transferId } }, options)
    )
  }

  private forwardTo(
    attachment: Attachment,
    request: DesktopBrowserBridgeForward,
    options: { timeoutMs: number; signal?: AbortSignal }
  ): Promise<unknown> {
    const requestId = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        this.stagedResults.release(requestId)
        options.signal?.removeEventListener('abort', onAbort)
      }
      let emitted = false
      // Revoke queued desktop work when the CLI gives up.
      const cancelOnDesktop = (): void => {
        if (!emitted || !attachment.acceptsCancel || !this.attachments.includes(attachment)) {
          return
        }
        try {
          attachment.emit({ type: 'cancel', requestId })
        } catch {
          // The socket is gone, so the desktop's own detach revokes the command.
        }
      }
      const onAbort = (): void => {
        settle()
        cancelOnDesktop()
        reject(new BrowserError('browser_aborted', 'The browser command was cancelled.'))
      }
      const timer = setTimeout(() => {
        settle()
        cancelOnDesktop()
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
        timer,
        ...(request.readablePaths ? { readablePaths: new Set(request.readablePaths) } : {})
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
          // Leave transit margin for desktop refusal before orcad's deadline.
          timeoutMs: Math.max(
            MIN_DESKTOP_DEADLINE_MS,
            options.timeoutMs - DESKTOP_DEADLINE_MARGIN_MS
          ),
          ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
          stagedResults: true
        })
        emitted = true
      } catch {
        this.pending.get(requestId)?.reject(unavailableError())
      }
    })
  }

  /** Only while the upload that named the file is still waiting on this caller's desktop. */
  async readHostFile(caller: Caller, params: DesktopBrowserBridgeFileReadParams) {
    if (!this.pendingFor(caller, params)?.readablePaths?.has(params.path)) {
      throw new Error('desktop_browser_bridge_file_not_granted')
    }
    const chunk = await readLocalFileRange(params.path, params.offset, params.length)
    return { ...chunk, totalBytes: params.offset + chunk.bytesRead }
  }

  async writeDownload(caller: Caller, params: DesktopBrowserBridgeDownloadWriteParams) {
    if (!this.attachmentFor(caller, params.attachmentId)) {
      throw new Error('desktop_browser_bridge_attachment_unknown')
    }
    return this.downloads.write(params)
  }

  abortDownload(caller: Caller, params: DesktopBrowserBridgeDownloadAbortParams): boolean {
    return this.attachmentFor(caller, params.attachmentId) ? this.downloads.abort(params) : false
  }

  /** False when the chunk is not for a command this caller's attachment is still answering. */
  appendResultChunk(caller: Caller, chunk: DesktopBrowserBridgeResultChunkParams): boolean {
    if (!this.pendingFor(caller, chunk)) {
      return false
    }
    this.stagedResults.append(chunk.requestId, chunk.offset, chunk.contentBase64)
    return true
  }

  settle(caller: Caller, result: DesktopBrowserBridgeResultParams): boolean {
    const pending = this.pendingFor(caller, result)
    if (!pending) {
      return false
    }
    if (result.ok && result.stagedResultBytes !== undefined) {
      const staged = this.stagedResults.take(result.requestId, result.stagedResultBytes)
      if (staged.ok) {
        pending.resolve(staged.value)
      } else {
        pending.reject(
          new BrowserError(
            staged.errorCode,
            'The desktop ran the command, but its large result did not arrive complete. Try again.'
          )
        )
      }
    } else if (result.ok) {
      pending.resolve(result.result)
    } else {
      pending.reject(new BrowserError(result.error.code, result.error.message, result.error.data))
    }
    return true
  }

  private pendingFor(
    caller: Caller,
    identity: { attachmentId: string; requestId: string }
  ): PendingRequest | null {
    const pending = this.pending.get(identity.requestId)
    return pending && pending.attachmentId === this.attachmentFor(caller, identity.attachmentId)
      ? pending
      : null
  }

  private attachmentFor(caller: Caller, attachmentId: string): string | null {
    const attachment = this.attachments.find((entry) => entry.attachmentId === attachmentId)
    return attachment &&
      attachment.connectionId === caller.connectionId &&
      attachment.pairedDeviceId === caller.pairedDeviceId
      ? attachment.attachmentId
      : null
  }

  private detach(attachmentId: string): void {
    const index = this.attachments.findIndex((entry) => entry.attachmentId === attachmentId)
    if (index === -1) {
      return
    }
    this.attachments.splice(index, 1)
    this.downloads.detach(attachmentId)
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
