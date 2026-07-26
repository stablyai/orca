import {
  SCRCPY_VIDEO_MAX_GOP_FRAMES,
  SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE,
  type ScrcpyVideoFrameMessage
} from '../emulator/scrcpy-video-registry'

const MAX_PENDING_FRAMES = SCRCPY_VIDEO_MAX_GOP_FRAMES + 1

export class EmulatorVideoFrameDelivery {
  private nextDeliveryId = 1
  private inFlightDeliveryId: number | null = null
  private pendingFrames: ScrcpyVideoFrameMessage[] = []
  private pendingBytes = 0
  private waitingForKeyFrame = false
  private waitingConfig: ScrcpyVideoFrameMessage | null = null

  constructor(
    private readonly send: (frame: ScrcpyVideoFrameMessage, deliveryId: number) => void
  ) {}

  enqueue(frame: ScrcpyVideoFrameMessage): void {
    if (this.waitingForKeyFrame) {
      this.enqueueWhileWaiting(frame)
      return
    }
    this.pendingFrames.push(frame)
    this.pendingBytes += frame.bytes.byteLength
    this.recoverFromOverflow()
    this.flushNext()
  }

  acknowledge(deliveryId: number): void {
    if (this.inFlightDeliveryId !== deliveryId) {
      return
    }
    this.inFlightDeliveryId = null
    this.flushNext()
  }

  clear(): void {
    this.inFlightDeliveryId = null
    this.pendingFrames = []
    this.pendingBytes = 0
    this.waitingForKeyFrame = false
    this.waitingConfig = null
  }

  private enqueueWhileWaiting(frame: ScrcpyVideoFrameMessage): void {
    if (frame.config) {
      this.waitingConfig =
        frame.bytes.byteLength <= SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE ? frame : null
      return
    }
    if (!frame.keyFrame) {
      return
    }
    const pendingFrames = this.waitingConfig ? [this.waitingConfig, frame] : [frame]
    const pendingBytes = pendingFrames.reduce(
      (total, pending) => total + pending.bytes.byteLength,
      0
    )
    this.waitingConfig = null
    if (pendingBytes > SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE) {
      return
    }
    this.waitingForKeyFrame = false
    this.pendingFrames = pendingFrames
    this.pendingBytes = pendingBytes
    this.flushNext()
  }

  private recoverFromOverflow(): void {
    if (
      this.pendingFrames.length <= MAX_PENDING_FRAMES &&
      this.pendingBytes <= SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE
    ) {
      return
    }

    const keyFrameIndex = this.findNewestKeyFrame()
    if (keyFrameIndex >= 0) {
      const startIndex = this.findConfigBeforeKeyFrame(keyFrameIndex)
      const recoverableFrames = this.pendingFrames.slice(startIndex)
      const recoverableBytes = recoverableFrames.reduce(
        (total, pending) => total + pending.bytes.byteLength,
        0
      )
      if (
        recoverableFrames.length <= MAX_PENDING_FRAMES &&
        recoverableBytes <= SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE
      ) {
        this.pendingFrames = recoverableFrames
        this.pendingBytes = recoverableBytes
        return
      }
    }

    this.waitingConfig = this.findNewestConfig()
    this.pendingFrames = []
    this.pendingBytes = 0
    this.waitingForKeyFrame = true
  }

  private findNewestKeyFrame(): number {
    for (let index = this.pendingFrames.length - 1; index >= 0; index -= 1) {
      if (this.pendingFrames[index].keyFrame) {
        return index
      }
    }
    return -1
  }

  private findConfigBeforeKeyFrame(keyFrameIndex: number): number {
    let startIndex = keyFrameIndex
    for (let index = keyFrameIndex - 1; index >= 0; index -= 1) {
      if (!this.pendingFrames[index].config) {
        break
      }
      startIndex = index
    }
    return startIndex
  }

  private findNewestConfig(): ScrcpyVideoFrameMessage | null {
    for (let index = this.pendingFrames.length - 1; index >= 0; index -= 1) {
      const frame = this.pendingFrames[index]
      if (frame.config && frame.bytes.byteLength <= SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE) {
        return frame
      }
    }
    return null
  }

  private flushNext(): void {
    if (this.inFlightDeliveryId !== null || this.pendingFrames.length === 0) {
      return
    }
    const frame = this.pendingFrames.shift()
    if (!frame) {
      return
    }
    this.pendingBytes -= frame.bytes.byteLength
    const deliveryId = this.nextDeliveryId
    this.nextDeliveryId += 1
    this.inFlightDeliveryId = deliveryId
    this.send(frame, deliveryId)
  }
}
