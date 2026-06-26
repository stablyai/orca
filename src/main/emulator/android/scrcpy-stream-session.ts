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

// A live scrcpy session validated against a real emulator. The connection
// handshake (dummy byte, 64-byte device name, codec meta) and the server option
// set are coupled to the pinned scrcpy server version; the pure framing
// (scrcpy-video-frame-parser) and control encoding (scrcpy-control-protocol) are
// unit-tested, while this orchestration is exercised live via probes.

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
  // scrcpy parses scid as a SIGNED 32-bit hex int, so mask to 31 bits and pad to
  // 8 hex digits to match the server's own %08x format.
  return (randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, '0')
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
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let serverLog = ''
    const capture = (chunk: Buffer): void => {
      serverLog += chunk.toString()
    }
    this.server.stdout?.on('data', capture)
    this.server.stderr?.on('data', capture)
    this.server.on('error', (error) => this.fail(error.message))
    this.server.on('exit', (code) => {
      emulatorProbe('scrcpy.server.exit', { code, log: serverLog.slice(0, 1000).trim() })
      this.close()
    })
  }

  private connectSockets(): void {
    this.openVideoSocket(0)
  }

  // adb accepts the forwarded TCP connection before the server's abstract socket
  // exists (then resets it), so retry until the server actually delivers bytes
  // (the dummy byte). Only then is the connection real; connect control after.
  private openVideoSocket(attempt: number): void {
    if (this.closed) {
      return
    }
    const socket = connect(this.port, '127.0.0.1')
    // A failed connect emits both 'error' and 'close'; settle once so retries
    // (and post-delivery close) don't fan out into exponential connection storms.
    let settled = false
    const retry = (): void => {
      if (settled || this.closed) {
        return
      }
      settled = true
      socket.destroy()
      if (attempt >= 100) {
        emulatorProbeError('scrcpy.socket.fail', new Error('no data'), { attempt })
        this.fail('scrcpy video stream did not start')
        return
      }
      setTimeout(() => this.openVideoSocket(attempt + 1), 100)
    }
    socket.once('data', (chunk: Buffer) => {
      if (settled) {
        return
      }
      settled = true
      emulatorProbe('scrcpy.video.connected', { attempt, bytes: chunk.length })
      this.videoSocket = socket
      socket.on('data', (next: Buffer) => this.handleVideoChunk(next))
      socket.on('error', (error) => this.fail(error.message))
      this.handleVideoChunk(chunk)
      this.openControlSocket()
    })
    socket.once('error', retry)
    socket.once('close', retry)
  }

  private openControlSocket(): void {
    if (this.closed) {
      return
    }
    const socket = connect(this.port, '127.0.0.1')
    socket.on('error', () => {})
    this.controlSocket = socket
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
