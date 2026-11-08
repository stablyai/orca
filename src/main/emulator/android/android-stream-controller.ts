import type { EmulatorSessionInfo } from '../emulator-types'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import type { AndroidCommandRunner } from './android-command-runner'
import {
  androidStreamSessionInfo,
  type AndroidStreamHandle,
  type StartAndroidStream
} from './android-stream-session-starter'
import { scrcpyVideoRegistry } from '../scrcpy-video-registry'
import { nativeAndroidSessions, startNativeAndroidSession } from './emulator-grpc-session'
import { ScrcpyStreamSession } from './scrcpy-stream-session'

export type AndroidStreamControllerDeps = {
  runner: AndroidCommandRunner
  sdk: () => AndroidSdkPaths
  ensureJar: () => Promise<string>
  startStreamSession: StartAndroidStream
  maxSize: number
  nativeEmulator?: boolean
}

// Deduplicate starts so racing attaches cannot launch competing scrcpy servers.
export class AndroidStreamController {
  private readonly handles = new Map<string, AndroidStreamHandle>()
  private readonly starts = new Map<string, Promise<EmulatorSessionInfo>>()

  constructor(private readonly deps: AndroidStreamControllerDeps) {}

  async start(serial: string): Promise<EmulatorSessionInfo> {
    const inFlight = this.starts.get(serial)
    if (inFlight) {
      return inFlight
    }
    const start = this.begin(serial)
    this.starts.set(serial, start)
    try {
      return await start
    } finally {
      this.starts.delete(serial)
    }
  }

  private async begin(serial: string): Promise<EmulatorSessionInfo> {
    const native = nativeAndroidSessions.get(serial)
    if (native && (await native.isReusable())) {
      return native.info
    }
    if (this.handles.has(serial) && scrcpyVideoRegistry.has(serial)) {
      return androidStreamSessionInfo(serial)
    }
    this.handles.delete(serial)
    if (this.deps.nativeEmulator) {
      const session = await startNativeAndroidSession(serial)
      if (session) {
        try {
          const control = await ScrcpyStreamSession.start(
            {
              runner: this.deps.runner,
              sdk: this.deps.sdk(),
              serial,
              localJarPath: await this.deps.ensureJar(),
              video: false
            },
            {
              onMeta: () => {},
              onFrame: () => {},
              onError: () => {
                void session.close()
              },
              onClose: () => {
                void session.close()
              }
            }
          )
          session.attachKeyboard(control)
          if (await session.isReusable()) {
            this.handles.set(serial, session)
            return session.info
          }
        } catch {
          await session.close()
        }
      }
    }
    const jarPath = await this.deps.ensureJar()
    const { info, handle } = await this.deps.startStreamSession({
      runner: this.deps.runner,
      sdk: this.deps.sdk(),
      serial,
      jarPath,
      maxSize: this.deps.maxSize
    })
    this.handles.set(serial, handle)
    return info
  }

  async stop(serial: string): Promise<void> {
    const handle = this.handles.get(serial)
    if (handle) {
      this.handles.delete(serial)
      await handle.close()
    }
  }
}
