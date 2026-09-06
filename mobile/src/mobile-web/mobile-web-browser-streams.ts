import {
  MobileWebSubscriptionLedger,
  type MobileWebSubscriptionLedgerConfig,
  type MobileWebSubscriptionRecord
} from './mobile-web-subscription-ledger'
import { Buffer } from 'buffer/'
import {
  MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES,
  MOBILE_WEB_BROWSER_FRAME_MAX_IMAGE_BYTES,
  MobileWebBrowserEventSchema,
  MobileWebBrowserStreamPayloadSchema,
  type MobileWebBrowserEvent
} from '../../../src/shared/mobile-web/browser-operation-contract'
import type {
  BrowserScreencastFrame,
  BrowserScreencastFrameMetadata
} from '../transport/browser-screencast-protocol'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { sanitizeMobileWebBrowserEvent } from './mobile-web-browser-event-sanitizer'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

type ScreencastRecord = MobileWebSubscriptionRecord & {
  frameQueued: boolean
  pendingFrame: BrowserScreencastFrame | null
}

type BrowserLedgerConfig = MobileWebSubscriptionLedgerConfig<MobileWebBrowserEvent> & {
  workspaceAuthority: MobileWebWorkspaceAuthority
  browserAuthority: MobileWebBrowserAuthority
}

export class MobileWebBrowserStreams extends MobileWebSubscriptionLedger<
  MobileWebBrowserEvent,
  ScreencastRecord
> {
  constructor(private readonly config: BrowserLedgerConfig) {
    super({ ...config, operationKey: 'browser.subscribe' })
  }

  start(args: {
    requestId: string
    subscriptionId: string
    payload: unknown
    client: RpcClient
  }): void {
    this.admit(args.subscriptionId)
    const payload = MobileWebBrowserStreamPayloadSchema.parse(args.payload)
    const hostWorkspaceId = this.config.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const hostPageId = this.config.browserAuthority.hostPageId(hostWorkspaceId, payload.pageId)
    const record: ScreencastRecord = {
      ...this.newRecord(args.requestId),
      frameQueued: false,
      pendingFrame: null
    }
    this.open(args.subscriptionId, record, () =>
      args.client.subscribe(
        'browser.screencast',
        {
          worktree: `id:${hostWorkspaceId}`,
          page: hostPageId,
          format: payload.format,
          quality: payload.quality,
          maxWidth: payload.maxWidth,
          maxHeight: payload.maxHeight,
          everyNthFrame: payload.everyNthFrame,
          minFrameIntervalMs: payload.minFrameIntervalMs,
          ...(payload.viewportWidth === undefined ? {} : { viewportWidth: payload.viewportWidth }),
          ...(payload.viewportHeight === undefined
            ? {}
            : { viewportHeight: payload.viewportHeight }),
          ...(payload.deviceScaleFactor === undefined
            ? {}
            : { deviceScaleFactor: payload.deviceScaleFactor }),
          ...(payload.mobile === undefined ? {} : { mobile: payload.mobile })
        },
        (event) => this.receiveEvent(args.subscriptionId, record, event),
        {
          onBinaryFrame: (frame) => this.receiveFrame(args.subscriptionId, record, frame)
        }
      )
    )
  }

  // Drops the parked image so a retired stream cannot pin a multi-megabyte frame.
  protected override retire(record: ScreencastRecord): void {
    record.pendingFrame = null
  }

  private receiveEvent(subscriptionId: string, record: ScreencastRecord, value: unknown): void {
    if (!this.isCurrent(subscriptionId, record)) {
      return
    }
    const event = sanitizeMobileWebBrowserEvent(value)
    if (event) {
      this.enqueueTask(subscriptionId, record, () => this.deliver(subscriptionId, record, event))
    }
  }

  private receiveFrame(
    subscriptionId: string,
    record: ScreencastRecord,
    frame: BrowserScreencastFrame
  ): void {
    if (!this.isCurrent(subscriptionId, record)) {
      return
    }
    if (frame.image.byteLength > MOBILE_WEB_BROWSER_FRAME_MAX_IMAGE_BYTES) {
      this.enqueueTask(subscriptionId, record, () =>
        this.deliver(subscriptionId, record, {
          type: 'error',
          message: 'Browser frame is too large to display safely.'
        })
      )
      return
    }
    record.pendingFrame = frame
    if (record.frameQueued) {
      return
    }
    record.frameQueued = true
    this.enqueueTask(subscriptionId, record, async () => {
      const latest = record.pendingFrame
      record.pendingFrame = null
      if (latest) {
        await this.deliverFrame(subscriptionId, record, latest)
      }
      record.frameQueued = false
      const pending = record.pendingFrame
      if (pending && this.isCurrent(subscriptionId, record)) {
        record.pendingFrame = null
        this.receiveFrame(subscriptionId, record, pending)
      }
    })
  }

  private async deliverFrame(
    subscriptionId: string,
    record: ScreencastRecord,
    frame: BrowserScreencastFrame
  ): Promise<void> {
    const chunkCount = Math.ceil(frame.image.byteLength / MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES)
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      if (!this.isCurrent(subscriptionId, record)) {
        return
      }
      const start = chunkIndex * MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES
      const end = Math.min(frame.image.byteLength, start + MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES)
      await this.deliver(subscriptionId, record, {
        type: 'frameChunk',
        frameSequence: frame.seq,
        format: frame.format,
        metadata: boundedMetadata(frame.metadata),
        imageBytes: frame.image.byteLength,
        chunkIndex,
        chunkCount,
        data: Buffer.from(frame.image.subarray(start, end)).toString('base64')
      })
    }
  }

  // Why the sequence is claimed here and not at enqueue time: one queued frame task posts a whole
  // chunk run, so the numbers must be handed out per post, in post order.
  private async deliver(
    subscriptionId: string,
    record: ScreencastRecord,
    value: MobileWebBrowserEvent
  ): Promise<void> {
    const event = MobileWebBrowserEventSchema.parse(value)
    const sequence = record.sequence
    record.sequence += 1
    await this.options.postEvent(subscriptionId, sequence, event)
  }
}

function boundedMetadata(metadata: BrowserScreencastFrameMetadata): BrowserScreencastFrameMetadata {
  const parsed = MobileWebBrowserEventSchema.parse({
    type: 'frameChunk',
    frameSequence: 0,
    format: 'jpeg',
    metadata,
    imageBytes: 1,
    chunkIndex: 0,
    chunkCount: 1,
    data: 'AA=='
  })
  if (parsed.type !== 'frameChunk') {
    throw new MobileWebBrokerError('host_error')
  }
  return parsed.metadata
}
