import type { EmulatorSessionInfo } from '../emulator-types'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'
import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonyStreamHandle, StartHarmonyStream } from './harmony-stream-session-starter'

export type HarmonyStreamControllerDeps = {
  startStreamSession: StartHarmonyStream
  runner: HarmonyCommandRunner
  sdk: () => HarmonySdkPaths
  frameIntervalMs?: number
}

type HarmonyStreamEntry = { handle: HarmonyStreamHandle; info: EmulatorSessionInfo }

// Owns the per-connectKey MJPEG server lifecycle and dedupes concurrent starts
// so two racing attaches never spawn duplicate servers for one target.
export class HarmonyStreamController {
  private readonly entries = new Map<string, HarmonyStreamEntry>()
  private readonly starts = new Map<string, Promise<EmulatorSessionInfo>>()

  constructor(private readonly deps: HarmonyStreamControllerDeps) {}

  async start(connectKey: string): Promise<EmulatorSessionInfo> {
    const inFlight = this.starts.get(connectKey)
    if (inFlight) {
      return inFlight
    }
    const start = this.begin(connectKey)
    this.starts.set(connectKey, start)
    try {
      return await start
    } finally {
      this.starts.delete(connectKey)
    }
  }

  has(connectKey: string): boolean {
    return this.entries.has(connectKey)
  }

  private async begin(connectKey: string): Promise<EmulatorSessionInfo> {
    const existing = this.entries.get(connectKey)
    if (existing) {
      return existing.info
    }
    const { info, handle } = await this.deps.startStreamSession({
      runner: this.deps.runner,
      sdk: this.deps.sdk(),
      frameIntervalMs: this.deps.frameIntervalMs,
      connectKey
    })
    this.entries.set(connectKey, { handle, info })
    return info
  }

  stop(connectKey: string): void {
    const entry = this.entries.get(connectKey)
    if (entry) {
      entry.handle.close()
      this.entries.delete(connectKey)
    }
  }
}
