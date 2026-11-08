import { EmulatorPointerContact } from './emulator-pointer-contact'
import {
  sendScrcpyKeyboard,
  sendScrcpyDisplayScroll as scrollDisplay,
  type AndroidKeyboardInput
} from './scrcpy-control-input'
import type { ScrcpyStreamSession } from './scrcpy-stream-session'
import { emulatorDisplayCoordinates } from './emulator-display-coordinates'
import type { ClientWritableStream } from '@grpc/grpc-js'
import { connectivityState } from '@grpc/grpc-js'
import type { NativeVideoFrame, NativeVideoViewer } from '../../../shared/emulator-native-video'
import type { EmulatorSessionInfo } from '../emulator-types'
import { discoverEmulatorGrpc } from './emulator-grpc-discovery'
import { emulatorProbeError } from '../emulator-probe'
import {
  EmulatorGrpcClient,
  isUnsupportedEmulatorGrpc,
  type GrpcInput
} from './emulator-grpc-protocol'

export const nativeAndroidSessions = new Map<string, EmulatorGrpcSession>()
const unavailableUntil = new Map<string, number>()

/** Returns null during cooldown or failed discovery so the caller can start scrcpy. */
export async function startNativeAndroidSession(
  serial: string
): Promise<EmulatorGrpcSession | null> {
  if ((unavailableUntil.get(serial) ?? 0) > Date.now()) {
    return null
  }
  const existing = nativeAndroidSessions.get(serial)
  if (existing) {
    return existing
  }
  const endpoint = await discoverEmulatorGrpc(serial)
  if (!endpoint) {
    return null
  }
  const grpc = new EmulatorGrpcClient(endpoint)
  try {
    const size = await grpc.displaySize()
    const session = new EmulatorGrpcSession(serial, grpc, size)
    nativeAndroidSessions.set(serial, session)
    return session
  } catch (error) {
    emulatorProbeError('emulator.grpc.unavailable', error, { serial })
    grpc.client.close()
    return null
  }
}

export class EmulatorGrpcSession {
  readonly info: EmulatorSessionInfo
  private screenshots: ReturnType<EmulatorGrpcClient['screenshots']> | null = null
  private input: ClientWritableStream<GrpcInput> | null = null
  private readonly viewers = new Set<NativeVideoViewer>()
  private rotation = 0
  private inputRotation: number | null = null
  private readonly contact = new EmulatorPointerContact((touch) =>
    this.send({ touchEvent: { touches: [touch] } })
  )
  private readonly mouseContact = new EmulatorPointerContact((touch) =>
    this.send({
      mouseEvent: { x: touch.x, y: touch.y, buttons: touch.pressure ? 1 : 0 }
    })
  )
  private paneContact = this.mouseContact
  private requestedSize = ''
  private closed = false
  private closing = Promise.resolve()
  private firstFrameTimer: ReturnType<typeof setTimeout> | undefined
  private keyboardControl: ScrcpyStreamSession | null = null

  constructor(
    readonly serial: string,
    private readonly grpc: EmulatorGrpcClient,
    private readonly display: { width: number; height: number }
  ) {
    this.info = {
      deviceUdid: serial,
      streamUrl: `android-grpc://${serial}`,
      wsUrl: '',
      backend: 'android',
      streamCodec: 'rgb888'
    }
    const channel = grpc.client.getChannel()
    const watch = () => {
      if (this.closed) {
        return
      }
      const state = channel.getConnectivityState(false)
      if (state === connectivityState.TRANSIENT_FAILURE || state === connectivityState.SHUTDOWN) {
        this.close()
        return
      }
      channel.watchConnectivityState(state, Date.now() + 60_000, watch)
    }
    queueMicrotask(watch)
  }

  /** The returned cleanup releases held input; the last viewer parks screenshot capture. */
  subscribe(viewer: NativeVideoViewer): () => void {
    if (this.closed) {
      viewer.end()
      return () => {}
    }
    this.viewers.add(viewer)
    this.resize()
    return () => {
      this.release()
      this.viewers.delete(viewer)
      this.resize()
    }
  }

  /** All viewers share the largest bounded capture size; replaced streams must not terminate it. */
  private resize(): void {
    if (this.closed) {
      return
    }
    const width = Math.min(4096, Math.max(1, ...[...this.viewers].map((viewer) => viewer.width)))
    const height = Math.min(4096, Math.max(1, ...[...this.viewers].map((viewer) => viewer.height)))
    const key = this.viewers.size ? `${width}:${height}` : ''
    if (this.requestedSize === key) {
      return
    }
    this.requestedSize = key
    clearTimeout(this.firstFrameTimer)
    this.release()
    const old = this.screenshots
    this.screenshots = null
    old?.cancel()
    if (!this.viewers.size) {
      return
    }
    const stream = this.grpc.screenshots(width, height)
    this.screenshots = stream
    this.firstFrameTimer = setTimeout(() => {
      unavailableUntil.set(this.serial, Date.now() + 30_000)
      this.close()
    }, 10_000)
    stream.on('data', (image) => {
      if (stream !== this.screenshots) {
        return
      }
      if (!image.format || !image.image) {
        this.close()
        return
      }
      if (image.format.foldedDisplay?.width) {
        unavailableUntil.set(this.serial, Date.now() + 30_000)
        this.close()
        return
      }
      const { width, height } = image.format
      clearTimeout(this.firstFrameTimer)
      // The emulator publishes an empty image while the display is asleep.
      if (!width && !height) {
        return
      }
      if (
        !width ||
        !height ||
        width > 4096 ||
        height > 4096 ||
        image.image.length !== width * height * 3
      ) {
        this.close()
        return
      }
      const rotation = image.format.rotation?.rotation ?? 0
      if (rotation !== this.rotation) {
        this.release()
        this.rotation = rotation
      }
      const frame: NativeVideoFrame = {
        width,
        height,
        rotation,
        pixels: image.image,
        sequence: image.seq,
        timestampUs: image.timestampUs.toString()
      }
      for (const viewer of this.viewers) {
        viewer.frame(frame)
      }
    })
    stream.on('error', (error: unknown) => {
      if (stream === this.screenshots) {
        if (isUnsupportedEmulatorGrpc(error)) {
          unavailableUntil.set(this.serial, Date.now() + 30_000)
        }
        this.close(isUnsupportedEmulatorGrpc(error))
      }
    })
    stream.on('end', () => {
      if (stream === this.screenshots) {
        this.close()
      }
    })
  }

  setInputRotation(rotation: number): void {
    this.inputRotation = rotation
  }
  /** Release held input before rotating; unsupported RPCs disable native startup temporarily. */
  async rotate(quadrants: number): Promise<void> {
    this.release()
    try {
      await this.grpc.rotate(quadrants)
    } catch (error) {
      if (isUnsupportedEmulatorGrpc(error)) {
        unavailableUntil.set(this.serial, Date.now() + 30_000)
      }
      this.close()
      throw error
    }
  }
  /** Probe live display dimensions before reusing a session that may have outlived the device. */
  async isReusable(): Promise<boolean> {
    if (this.closed) {
      return false
    }
    try {
      Object.assign(this.display, await this.grpc.displaySize())
      return true
    } catch {
      this.close()
      return false
    }
  }

  /** Normalized pane coordinates are mapped back to the natural display orientation. */
  touch(phase: 'begin' | 'move' | 'end', x: number, y: number): boolean {
    return this.contact.touch(
      phase,
      emulatorDisplayCoordinates(x, y, this.inputRotation ?? this.rotation, this.display)
    )
  }

  /** Mouse contacts avoid Android touch slop; pens and touchscreens retain touch semantics. */
  pointer(phase: 'begin' | 'move' | 'end', x: number, y: number, pointerType?: string): boolean {
    if (phase === 'begin') {
      this.release()
      this.paneContact =
        pointerType === 'touch' || pointerType === 'pen' ? this.contact : this.mouseContact
    }
    return this.paneContact.touch(
      phase,
      emulatorDisplayCoordinates(x, y, this.inputRotation ?? this.rotation, this.display)
    )
  }

  /** Use the last presented rotation so wheel coordinates match the frame the user sees. */
  scroll(...scroll: [number, number, number, number]): boolean {
    const rotation = this.inputRotation ?? this.rotation
    return scrollDisplay(this.keyboardControl, this.display, rotation, scroll)
  }

  /** Own the control-only scrcpy session, closing replacements and late arrivals. */
  attachKeyboard(control: ScrcpyStreamSession): void {
    this.keyboardControl?.close()
    if (this.closed) {
      control.close()
      return
    }
    this.keyboardControl = control
  }

  /** False means the live control transport cannot accept input and callers may fall back. */
  async keyboard(value: AndroidKeyboardInput): Promise<boolean> {
    return !this.closed && this.keyboardControl
      ? sendScrcpyKeyboard(this.keyboardControl, value)
      : false
  }

  release(): void {
    this.contact.release()
    this.mouseContact.release()
  }

  /** Close a stalled input stream instead of queuing unbounded interactions. */
  private send(event: GrpcInput): boolean {
    if (this.closed) {
      return false
    }
    if (!this.input) {
      this.input = this.grpc.input()
      this.input.on('error', (error: unknown) => {
        if (isUnsupportedEmulatorGrpc(error)) {
          unavailableUntil.set(this.serial, Date.now() + 30_000)
        }
        this.close()
      })
    }
    // Do not buffer unlimited input behind a stalled emulator.
    if (this.input.writableLength >= 64) {
      this.close()
      return false
    }
    this.input.write(event)
    return true
  }

  /** Idempotently releases owned transports; unsupported screenshot RPCs request a scrcpy retry. */
  close(retryWithScrcpy = false): Promise<void> {
    if (this.closed) {
      return this.closing
    }
    this.release()
    if (this.closed) {
      return this.closing
    }
    this.closed = true
    this.keyboardControl?.close()
    this.keyboardControl = null
    clearTimeout(this.firstFrameTimer)
    nativeAndroidSessions.delete(this.serial)
    const stream = this.screenshots
    this.screenshots = null
    stream?.cancel()
    this.closing = this.grpc.close(this.input)
    for (const viewer of this.viewers) {
      viewer.end(retryWithScrcpy)
    }
    this.viewers.clear()
    return this.closing
  }
}
