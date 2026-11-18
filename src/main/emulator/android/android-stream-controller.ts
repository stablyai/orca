import { randomUUID } from 'node:crypto'
import { EmulatorError } from '../emulator-errors'
import type { EmulatorSessionInfo } from '../emulator-types'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidStreamHandle, StartAndroidStream } from './android-stream-session-starter'
import { scrcpyVideoRegistry } from '../scrcpy-video-registry'

export type AndroidStreamControllerDeps = {
  runner: AndroidCommandRunner
  sdk: () => AndroidSdkPaths
  ensureJar: () => Promise<string>
  startStreamSession: StartAndroidStream
  maxSize: number
}

// Deduplicate starts so racing attaches cannot launch competing scrcpy servers.
export class AndroidStreamController {
  private readonly handles = new Map<
    string,
    { handle: AndroidStreamHandle; info: EmulatorSessionInfo }
  >()
  private readonly starts = new Map<string, Promise<EmulatorSessionInfo>>()

  constructor(private readonly deps: AndroidStreamControllerDeps) {}

  async start(serial: string, assertOpen: () => void = () => {}): Promise<EmulatorSessionInfo> {
    assertOpen()
    const inFlight = this.starts.get(serial)
    if (inFlight) {
      return inFlight
    }
    const start = this.begin(serial, assertOpen)
    this.starts.set(serial, start)
    try {
      return await start
    } finally {
      this.starts.delete(serial)
    }
  }

  private async begin(serial: string, assertOpen: () => void): Promise<EmulatorSessionInfo> {
    if (this.handles.has(serial) && scrcpyVideoRegistry.has(serial)) {
      return this.handles.get(serial)!.info
    }
    this.handles.delete(serial)
    const jarPath = await this.deps.ensureJar()
    assertOpen()
    const { info, handle } = await this.deps.startStreamSession({
      runner: this.deps.runner,
      sdk: this.deps.sdk(),
      serial,
      jarPath,
      maxSize: this.deps.maxSize,
      assertOpen
    })
    try {
      assertOpen()
    } catch (error) {
      handle.close()
      throw error
    }
    const sessionInfo = { ...info, instanceId: randomUUID() }
    this.handles.set(serial, { handle, info: sessionInfo })
    return sessionInfo
  }

  isCurrent(info: EmulatorSessionInfo): boolean {
    const session = this.handles.get(info.deviceUdid)
    return (
      !!info.instanceId &&
      session?.info.instanceId === info.instanceId &&
      scrcpyVideoRegistry.has(info.deviceUdid)
    )
  }

  async stopForCleanup(
    serial: string,
    options: { instanceId?: string; requireInstanceId?: boolean; shutdownDevice?: boolean },
    shutdown: () => Promise<void>
  ): Promise<void> {
    if (
      options.requireInstanceId &&
      (!options.instanceId ||
        !this.isCurrent({
          deviceUdid: serial,
          instanceId: options.instanceId,
          streamUrl: '',
          wsUrl: ''
        }))
    ) {
      if (!options.shutdownDevice && options.instanceId) {
        return
      }
      throw new EmulatorError(
        'emulator_helper_failed',
        'The Android emulator stream changed before cleanup.'
      )
    }
    this.stop(serial)
    if (options.shutdownDevice) {
      await shutdown()
    }
  }

  stopAll(): void {
    for (const serial of this.handles.keys()) {
      this.stop(serial)
    }
  }

  stop(serial: string): void {
    const session = this.handles.get(serial)
    if (session) {
      session.handle.close()
      this.handles.delete(serial)
    }
  }
}
