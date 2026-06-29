import type { EmulatorSessionInfo } from '../emulator-types'
import { scrcpyVideoRegistry } from '../scrcpy-video-registry'
import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { ScrcpyStreamSession } from './scrcpy-stream-session'

export type AndroidStreamHandle = { close: () => void }

export type StartAndroidStreamParams = {
  runner: AndroidCommandRunner
  sdk: AndroidSdkPaths
  serial: string
  jarPath: string
  maxSize?: number
}

export type StartAndroidStream = (
  params: StartAndroidStreamParams
) => Promise<{ info: EmulatorSessionInfo; handle: AndroidStreamHandle }>

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength)
  new Uint8Array(arrayBuffer).set(buffer)
  return arrayBuffer
}

// Starts a scrcpy session for a booted device and pipes its meta + H.264 frames
// into the video registry (which the renderer subscribes to via IPC). Returns
// the session info (streamCodec h264) and a handle that tears everything down.
export const startAndroidStreamSession: StartAndroidStream = async ({
  runner,
  sdk,
  serial,
  jarPath,
  maxSize
}) => {
  let session: ScrcpyStreamSession | null = null
  // ScrcpyStreamSession.start waits for video meta, and that same startup path
  // may emit config/keyframes. Register first so those events seed replay cache.
  scrcpyVideoRegistry.register(serial, () => session?.close())
  try {
    session = await ScrcpyStreamSession.start(
      { runner, sdk, serial, localJarPath: jarPath, maxSize },
      {
        onMeta: (meta) => scrcpyVideoRegistry.pushMeta(serial, meta),
        onFrame: (frame) =>
          scrcpyVideoRegistry.pushFrame(serial, {
            config: frame.config,
            keyFrame: frame.keyFrame,
            pts: frame.pts.toString(),
            bytes: toArrayBuffer(frame.data)
          }),
        onError: () => scrcpyVideoRegistry.stop(serial),
        onClose: () => scrcpyVideoRegistry.stop(serial)
      }
    )
  } catch (error) {
    scrcpyVideoRegistry.stop(serial)
    throw error
  }

  let closed = false
  return {
    info: androidStreamSessionInfo(serial),
    handle: {
      close: () => {
        if (closed) {
          return
        }
        closed = true
        session?.close()
        scrcpyVideoRegistry.stop(serial)
      }
    }
  }
}

export function androidStreamSessionInfo(serial: string): EmulatorSessionInfo {
  return {
    deviceUdid: serial,
    streamUrl: `scrcpy://${serial}`,
    wsUrl: '',
    streamCodec: 'h264',
    backend: 'android'
  }
}
