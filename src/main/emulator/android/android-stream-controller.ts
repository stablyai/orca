import type { EmulatorSessionInfo } from '../emulator-types'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import type { AndroidCommandRunner } from './android-command-runner'
import {
  androidStreamSessionInfo,
  type AndroidStreamHandle,
  type StartAndroidStream
} from './android-stream-session-starter'
import { scrcpyVideoRegistry } from '../scrcpy-video-registry'

export type AndroidStreamControllerDeps = {
  runner: AndroidCommandRunner
  sdk: () => AndroidSdkPaths
  ensureJar: () => Promise<string>
  startStreamSession: StartAndroidStream
  maxSize: number
}

// Owns the per-serial scrcpy stream lifecycle and dedupes concurrent starts so
// two racing attaches never spawn duplicate servers fighting for the same port.
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
    // Reuse only a live stream; if the session died on its own the registry entry
    // is gone, so drop the stale handle and start fresh.
    if (this.handles.has(serial) && scrcpyVideoRegistry.has(serial)) {
      return androidStreamSessionInfo(serial)
    }
    this.handles.delete(serial)
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

  stop(serial: string): void {
    const handle = this.handles.get(serial)
    if (handle) {
      handle.close()
      this.handles.delete(serial)
    }
  }
}
