import type { EmulatorBridge } from '../emulator/emulator-bridge'
import { EmulatorError } from '../emulator/emulator-errors'
import type { AdbConnectionStatus } from '../emulator/android/adb-device-connection'

// Why: split out of orca-runtime-emulator.ts to stay under the max-lines
// limit (AGENTS.md: split the file, don't disable the rule).
export type RuntimeEmulatorAdbCommandHost = {
  // Reuses RuntimeEmulatorCommands' own bridge accessor (which also honors
  // the configured Android SDK path) rather than re-deriving it here.
  requireEmulatorBridge(): EmulatorBridge
}

// ADB network device connect/disconnect/status. Local-only: no SSH target,
// no host selector — adb connection state is host-level, not per-worktree.
// emulatorAdbConnect is the only caller of bridge.adbConnect (`adb connect`),
// matching the plan's "never auto-connect" hard rule.
export class RuntimeEmulatorAdbCommands {
  constructor(private readonly host: RuntimeEmulatorAdbCommandHost) {}

  async emulatorAdbConnect(params: {
    address: string
    worktree?: string
  }): Promise<AdbConnectionStatus> {
    return this.host.requireEmulatorBridge().adbConnect(params.address)
  }

  async emulatorAdbDisconnect(params: {
    address?: string
    worktree?: string
  }): Promise<AdbConnectionStatus> {
    const bridge = this.host.requireEmulatorBridge()
    return bridge.adbDisconnect(this.requireTargetAddress(bridge, params.address))
  }

  // Passive: never connects. With no address and nothing ever connected,
  // "disconnected" is itself the answer, not an error (unlike disconnect,
  // which needs a real target to act on).
  async emulatorAdbConnectionStatus(params: {
    address?: string
    worktree?: string
  }): Promise<AdbConnectionStatus> {
    const bridge = this.host.requireEmulatorBridge()
    const address = params.address ?? bridge.adbCurrentAddress()
    if (!address) {
      return { state: 'disconnected', address: null, serial: null }
    }
    return bridge.adbConnectionStatus(address)
  }

  private requireTargetAddress(bridge: EmulatorBridge, address: string | undefined): string {
    const resolved = address ?? bridge.adbCurrentAddress()
    if (!resolved) {
      throw new EmulatorError(
        'emulator_adb_not_connected',
        'No ADB device is connected. Specify an address or connect one first.'
      )
    }
    return resolved
  }
}
