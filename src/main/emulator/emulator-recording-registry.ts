import { EmulatorError } from './emulator-errors'

// One in-flight screen recording per device, keyed by resolved device id. Owned
// by the backend that spawned it so helper teardown and app quit can stop
// recordings instead of orphaning the capture process.

export type EmulatorRecording = {
  outputPath: string
  stop(): Promise<void>
}

export type EmulatorRecordingInfo = {
  deviceId: string
  outputPath: string
  startedAt: number
}

type RegistryEntry = {
  recording: EmulatorRecording
  startedAt: number
}

export class EmulatorRecordingRegistry {
  private readonly entries = new Map<string, RegistryEntry>()

  constructor(private readonly now: () => number = Date.now) {}

  has(deviceId: string): boolean {
    return this.entries.has(deviceId)
  }

  get(deviceId: string): EmulatorRecordingInfo | null {
    const entry = this.entries.get(deviceId)
    if (!entry) {
      return null
    }
    return { deviceId, outputPath: entry.recording.outputPath, startedAt: entry.startedAt }
  }

  list(): EmulatorRecordingInfo[] {
    return [...this.entries.entries()].map(([deviceId, entry]) => ({
      deviceId,
      outputPath: entry.recording.outputPath,
      startedAt: entry.startedAt
    }))
  }

  register(deviceId: string, recording: EmulatorRecording): EmulatorRecordingInfo {
    if (this.entries.has(deviceId)) {
      throw new EmulatorError(
        'emulator_error',
        `A screen recording is already running for ${deviceId}. Stop it before starting another.`
      )
    }
    const startedAt = this.now()
    this.entries.set(deviceId, { recording, startedAt })
    return { deviceId, outputPath: recording.outputPath, startedAt }
  }

  // Removes the entry before awaiting stop so a failed stop cannot wedge the
  // device into a permanent "already recording" state.
  async stop(deviceId: string): Promise<EmulatorRecordingInfo> {
    const entry = this.entries.get(deviceId)
    if (!entry) {
      throw new EmulatorError(
        'emulator_no_active',
        `No screen recording is running for ${deviceId}.`
      )
    }
    this.entries.delete(deviceId)
    await entry.recording.stop()
    return { deviceId, outputPath: entry.recording.outputPath, startedAt: entry.startedAt }
  }

  async stopIfRunning(deviceId: string): Promise<void> {
    if (this.entries.has(deviceId)) {
      await this.stop(deviceId).catch(() => {})
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((id) => this.stopIfRunning(id)))
  }
}
