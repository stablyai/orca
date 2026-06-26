import { spawn, type ChildProcess } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import {
  SCRCPY_DEVICE_JAR_PATH,
  pushScrcpyServerArgs,
  scrcpyForwardArgs,
  scrcpyRemoveForwardArgs,
  startScrcpyServerArgs
} from './scrcpy-server-deploy'
import {
  parseScrcpyVideoFrames,
  parseScrcpyVideoMeta,
  type ScrcpyVideoFrame,
  type ScrcpyVideoMeta
} from './scrcpy-video-frame-parser'
import { emulatorProbe, emulatorProbeError } from '../emulator-probe'

// ============================================================================
// UNVERIFIED — needs a real device + the bundled scrcpy-server.jar to validate.
// The connection handshake (dummy byte, 64-byte device name, codec meta) and
// the server option set are coupled to the scrcpy server version; the pure
// framing (scrcpy-video-frame-parser) and control encoding (scrcpy-control-
// protocol) ARE unit-tested. Treat this orchestration as scaffolding.
// ============================================================================

const DEVICE_NAME_BYTES = 64
const DUMMY_BYTE = 1

export type ScrcpyStreamCallbacks = {
  onMeta: (meta: ScrcpyVideoMeta) => void
  onFrame: (frame: ScrcpyVideoFrame) => void
  onError: (message: string) => void
  onClose: () => void
}

export type ScrcpyStreamOptions = {
  runner: AndroidCommandRunner
  sdk: AndroidSdkPaths
  serial: string
  localJarPath: string
  localPort?: number
  maxSize?: number
}

function newScid(): string {
  return randomBytes(4).toString('hex')
}

// A live scrcpy session: owns the server process, the adb tunnel, and the video
// + control sockets. Created via ScrcpyStreamSession.start().
export class ScrcpyStreamSession {
  private server: ChildProcess | null = null
  private videoSocket: Socket | null = null
  private controlSocket: Socket | null = null
  private pendingVideo: Buffer = Buffer.alloc(0)
  private metaSeen = false
  private headerStripped = false
  private closed = false

  private constructor(
    private readonly options: ScrcpyStreamOptions,
    private readonly callbacks: ScrcpyStreamCallbacks,
    private readonly scid: string,
    private readonly port: number
  ) {}

  static async start(
    options: ScrcpyStreamOptions,
    callbacks: ScrcpyStreamCallbacks
  ): Promise<ScrcpyStreamSession> {
    const scid = newScid()
    const port = options.localPort ?? 27183
    emulatorProbe('scrcpy.start', { serial: options.serial, port, scid })
    const session = new ScrcpyStreamSession(options, callbacks, scid, port)
    await session.deploy()
    session.spawnServer()
    session.connectSockets()
    return session
  }

  private async deploy(): Promise<void> {
    const { runner, sdk, serial, localJarPath } = this.options
    await runner(sdk.adb, pushScrcpyServerArgs(serial, localJarPath, SCRCPY_DEVICE_JAR_PATH))
    await runner(sdk.adb, scrcpyForwardArgs(serial, this.port, this.scid))
  }

  private spawnServer(): void {
    const { sdk, serial, maxSize } = this.options
    // The server is long-running, so spawn it directly rather than via the
    // request/response command runner.
    this.server = spawn(sdk.adb, startScrcpyServerArgs(serial, { scid: this.scid, maxSize }), {
      stdio: 'ignore'
    })
    this.server.on('error', (error) => this.fail(error.message))
    this.server.on('exit', () => this.close())
  }

  private connectSockets(): void {
    // tunnel_forward: the client opens the video socket first, then the control
    // socket, on the same forwarded port. A short retry covers server startup.
    this.videoSocket = this.connectWithRetry((socket) => this.attachVideo(socket))
    this.controlSocket = this.connectWithRetry(() => {})
  }

  private connectWithRetry(onReady: (socket: Socket) => void, attempt = 0): Socket {
    const socket = connect(this.port, '127.0.0.1')
    socket.once('connect', () => onReady(socket))
    socket.once('error', (error) => {
      if (this.closed) {
        return
      }
      if (attempt < 50) {
        setTimeout(() => this.connectWithRetry(onReady, attempt + 1), 100)
        return
      }
      this.fail(`scrcpy socket failed: ${error.message}`)
    })
    return socket
  }

  private attachVideo(socket: Socket): void {
    socket.on('data', (chunk: Buffer) => this.handleVideoChunk(chunk))
    socket.on('error', (error) => this.fail(error.message))
  }

  private handleVideoChunk(chunk: Buffer): void {
    let buffer = Buffer.concat([this.pendingVideo, chunk])
    // The first socket carries a 1-byte readiness marker + the 64-byte device name.
    if (!this.headerStripped) {
      const headerLen = DUMMY_BYTE + DEVICE_NAME_BYTES
      if (buffer.length < headerLen) {
        this.pendingVideo = buffer
        return
      }
      buffer = Buffer.from(buffer.subarray(headerLen))
      this.headerStripped = true
    }
    if (!this.metaSeen) {
      const meta = parseScrcpyVideoMeta(buffer)
      if (!meta) {
        this.pendingVideo = buffer
        return
      }
      this.metaSeen = true
      emulatorProbe('scrcpy.meta', meta)
      this.callbacks.onMeta(meta)
      buffer = Buffer.from(buffer.subarray(12))
    }
    const { frames, pending } = parseScrcpyVideoFrames(Buffer.alloc(0), buffer)
    this.pendingVideo = pending
    for (const frame of frames) {
      this.callbacks.onFrame(frame)
    }
  }

  // Sends an encoded scrcpy control message (see scrcpy-control-protocol).
  sendControl(message: Buffer): void {
    this.controlSocket?.write(message)
  }

  private fail(message: string): void {
    if (this.closed) {
      return
    }
    emulatorProbeError('scrcpy.fail', new Error(message), { serial: this.options.serial })
    this.callbacks.onError(message)
    this.close()
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    emulatorProbe('scrcpy.close', { serial: this.options.serial })
    this.videoSocket?.destroy()
    this.controlSocket?.destroy()
    this.server?.kill()
    void this.options
      .runner(this.options.sdk.adb, scrcpyRemoveForwardArgs(this.options.serial, this.port))
      .catch(() => {})
    this.callbacks.onClose()
  }
}
