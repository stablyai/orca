import { platform } from 'node:os'
import { EmulatorError } from '../emulator-errors'
import type { EmulatorSessionInfo } from '../emulator-types'
import {
  ensureSimulatorBooted,
  listSimulatorDevices,
  resolveSimulatorUdid,
  shutdownSimulatorDevice,
  type SimulatorDevice
} from '../simctl-simulator-devices'
import {
  execServeSimCommand,
  parseServeSimCommandArgs,
  resolveServeSimExecutable,
  stripEmulatorTargetArgs,
  type ServeSimExecutable
} from '../serve-sim-execution'
import { waitForServeSimEndpointReady } from '../serve-sim-endpoint-readiness'
import {
  killServeSimHelperProcessesForDevice,
  listServeSimHelperProcessesForDevice
} from '../serve-sim-helper-processes'
import type { EmulatorBridgeOptions } from '../emulator-bridge-types'
import { sendEmulatorGestureSequence, type EmulatorGesturePoint } from '../emulator-gesture-sender'
import { parseServeSimDetachedSession } from '../serve-sim-detached-session'
import { fetchServeSimAccessibilityTree, type FetchAccessibilityTree } from '../serve-sim-ax-tree'
import { hideNativeSimulatorApp } from '../simulator-app-visibility'
import type {
  BackendAvailability,
  EmulatorBackend,
  EmulatorBackendCapabilities,
  EmulatorDevice
} from './emulator-backend'

// The iOS/serve-sim backend: device/helper mechanics extracted from the former
// monolithic EmulatorBridge. The bridge now routes to this (and, later, an
// Android backend); per-worktree session state stays in the router.
export class IosEmulatorBackend implements EmulatorBackend {
  readonly kind = 'ios' as const
  readonly streamCodec = 'mjpeg' as const
  // iOS exposes install/launch/permissions/logcat via `exec`; ax has an explicit
  // verb backed by the active session's serve-sim /ax endpoint.
  readonly capabilities: EmulatorBackendCapabilities = {
    install: false,
    launch: false,
    permissions: false,
    accessibilityTree: true,
    logcat: false
  }

  private cachedServeSimExecutable: ServeSimExecutable | undefined
  private readonly waitForEndpointReady: (endpoint: string) => Promise<boolean>
  private readonly fetchAccessibilityTree: FetchAccessibilityTree

  constructor(options: EmulatorBridgeOptions = {}) {
    this.waitForEndpointReady = options.waitForEndpointReady ?? waitForServeSimEndpointReady
    this.fetchAccessibilityTree = options.fetchAccessibilityTree ?? fetchServeSimAccessibilityTree
  }

  // Why: resolving the executable can materialize the serve-sim runtime (a one-time
  // recursive copy + xattr subprocess on macOS after each version bump). Defer it
  // off the startup path — the bridge is constructed before the main window shows —
  // so it only runs when an emulator command is actually issued.
  private get serveSimExecutable(): ServeSimExecutable {
    this.cachedServeSimExecutable ??= resolveServeSimExecutable()
    return this.cachedServeSimExecutable
  }

  isSupportedOnHost(): boolean {
    return platform() === 'darwin'
  }

  async resolveDeviceId(deviceOrName: string): Promise<string> {
    return resolveSimulatorUdid(deviceOrName, this.serveSimExecutable)
  }

  async ownsDevice(id: string): Promise<boolean> {
    // iOS only owns devices on macOS; otherwise it must not claim Android serials.
    if (!this.isSupportedOnHost()) {
      return false
    }
    try {
      const needle = id.toLowerCase()
      const devices = await listSimulatorDevices()
      return devices.some((device) => device.udid === id || device.name.toLowerCase() === needle)
    } catch {
      return false
    }
  }

  async listDevices(): Promise<EmulatorDevice[]> {
    const devices = await listSimulatorDevices()
    return devices.map((device) => toEmulatorDevice(device))
  }

  // iOS-specific passthroughs the router exposes for back-compat with the
  // runtime/availability code (not part of the cross-backend interface).
  async listSimulators(): Promise<SimulatorDevice[]> {
    return listSimulatorDevices()
  }

  async listRunningHelpers(): Promise<unknown> {
    return this.execServeSim(['--list', '-q'], { json: true })
  }

  async checkServeSimAvailable(): Promise<void> {
    await this.execServeSim(['--help'], { timeoutMs: 10_000 })
  }

  async checkAvailability(): Promise<BackendAvailability> {
    if (!this.isSupportedOnHost()) {
      return { available: false, devices: [], message: 'iOS Simulator requires macOS.' }
    }
    let devices: EmulatorDevice[] = []
    try {
      devices = await this.listDevices()
    } catch (error) {
      return {
        available: false,
        devices: [],
        message: error instanceof Error ? error.message : 'xcrun simctl is unavailable.'
      }
    }
    if (devices.length === 0) {
      return {
        available: false,
        devices,
        message: 'No iOS simulators found. Add one in Xcode Settings > Platforms.'
      }
    }
    try {
      await this.checkServeSimAvailable()
    } catch (error) {
      return {
        available: false,
        devices,
        message: error instanceof Error ? error.message : 'serve-sim is unavailable.'
      }
    }
    return { available: true, devices, message: 'Ready' }
  }

  async tap(deviceId: string, x: number, y: number): Promise<void> {
    const udid = await this.resolveDeviceId(deviceId)
    await this.execServeSim(['tap', x.toString(), y.toString(), '-d', udid])
  }

  async gesture(
    _deviceId: string,
    points: EmulatorGesturePoint[],
    wsUrl: string | null
  ): Promise<void> {
    if (points.length === 0) {
      return
    }
    if (!wsUrl) {
      throw new EmulatorError('emulator_no_active', 'No active emulator stream for gesture input')
    }
    await sendEmulatorGestureSequence(wsUrl, points)
  }

  async type(deviceId: string, text: string): Promise<void> {
    const udid = await this.resolveDeviceId(deviceId)
    await this.execServeSim(['type', text, '-d', udid])
  }

  async button(deviceId: string, name: string): Promise<void> {
    const udid = await this.resolveDeviceId(deviceId)
    await this.execServeSim(['button', name, '-d', udid])
  }

  async rotate(deviceId: string, orientation: string): Promise<void> {
    const udid = await this.resolveDeviceId(deviceId)
    await this.execServeSim(['rotate', orientation, '-d', udid])
  }

  // Mirrors gesture: the tree comes from the active session's helper endpoint,
  // so without a session there is nothing to query.
  async accessibilityTree(_deviceId: string, axUrl: string | null): Promise<unknown> {
    if (!axUrl) {
      throw new EmulatorError(
        'emulator_no_active',
        'No active emulator session for the accessibility tree. Start one first.'
      )
    }
    return this.fetchAccessibilityTree(axUrl)
  }

  async exec(deviceId: string, command: string): Promise<unknown> {
    const udid = await this.resolveDeviceId(deviceId)
    const rawArgs = stripEmulatorTargetArgs(parseServeSimCommandArgs(command.trim()))
    return this.execServeSim([...rawArgs, '-d', udid], { json: true })
  }

  async startSession(deviceId: string): Promise<EmulatorSessionInfo> {
    const udid = await this.resolveDeviceId(deviceId)
    await ensureSimulatorBooted(udid)
    const startDetachedHelper = async (): Promise<EmulatorSessionInfo> => {
      const raw = await this.execServeSim(['--detach', '-q', udid], { json: true })
      return parseServeSimDetachedSession(raw, udid)
    }

    const waitForReadyOrKill = async (info: EmulatorSessionInfo): Promise<boolean> => {
      if (
        (await this.waitForEndpointReady(info.streamUrl)) &&
        (await this.hasHelperForSession(info))
      ) {
        return true
      }
      await this.stopHelperForDevice(info.deviceUdid, {
        helperPid: info.helperPid,
        includeOrphaned: true
      })
      return false
    }

    const throwPersistentMissingFramebuffer = (error: EmulatorError): never => {
      throw new EmulatorError(
        'emulator_helper_failed',
        `Simulator ${udid} keeps booting without a working display (no framebuffer descriptor), even after a reboot. Erase it with \`xcrun simctl erase ${udid}\` or recreate it in Xcode > Window > Devices and Simulators.\n\n${error.message}`
      )
    }

    // Why: CoreSimulator can report "Booted" with the display IO ports down
    // (HID alive, no framebuffer); a shutdown/boot recycle is the only recovery.
    let didRecycleWedgedBoot = false
    const startHelperRecyclingWedgedBoot = async (): Promise<EmulatorSessionInfo> => {
      try {
        return await startDetachedHelper()
      } catch (error) {
        if (!isMissingFramebufferError(error)) {
          throw error
        }
        if (didRecycleWedgedBoot) {
          return throwPersistentMissingFramebuffer(error)
        }
        didRecycleWedgedBoot = true
        await shutdownSimulatorDevice(udid)
        await ensureSimulatorBooted(udid)
        try {
          return await startDetachedHelper()
        } catch (retryError) {
          if (!isMissingFramebufferError(retryError)) {
            throw retryError
          }
          return throwPersistentMissingFramebuffer(retryError)
        }
      }
    }

    let info = await startHelperRecyclingWedgedBoot()
    if (!(await waitForReadyOrKill(info))) {
      info = await startHelperRecyclingWedgedBoot()
      if (!(await waitForReadyOrKill(info))) {
        throw new EmulatorError(
          'emulator_helper_failed',
          'serve-sim started but its stream endpoint is not reachable.'
        )
      }
    }
    // Why: serve-sim/CoreSimulator can surface Simulator.app while Orca embeds the stream.
    await hideNativeSimulatorApp().catch(() => {})
    return { ...info, streamCodec: 'mjpeg', backend: 'ios' }
  }

  async stopHelperForDevice(
    deviceId: string,
    options: { helperPid?: number; includeOrphaned?: boolean } = {}
  ): Promise<void> {
    await this.execServeSim(['--kill', '-q', deviceId]).catch(() => {})
    // Why: serve-sim --kill depends on its state file; stale helper binaries
    // can survive state loss and keep old streams/listeners around.
    await killServeSimHelperProcessesForDevice(deviceId, options).catch(() => {})
  }

  async shutdownDevice(deviceId: string): Promise<void> {
    await shutdownSimulatorDevice(deviceId)
  }

  async isSessionReusable(info: EmulatorSessionInfo): Promise<boolean> {
    if (!(await this.waitForEndpointReady(info.streamUrl))) {
      return false
    }
    return this.hasHelperForSession(info)
  }

  private async hasHelperForSession(info: EmulatorSessionInfo): Promise<boolean> {
    const helpers = await listServeSimHelperProcessesForDevice(info.deviceUdid, {
      helperPid: info.helperPid,
      includeOrphaned: true
    }).catch(() => [])
    return helpers.length > 0
  }

  private async execServeSim(
    args: string[],
    options?: { json?: boolean; timeoutMs?: number }
  ): Promise<unknown> {
    return execServeSimCommand(this.serveSimExecutable, args, options)
  }
}

// Why: serve-sim's capture helper prints exactly this when a booted device has
// no com.apple.framebuffer.display IO port: the signature of a wedged boot.
const MISSING_FRAMEBUFFER_RE = /No framebuffer display descriptor found/i

function isMissingFramebufferError(error: unknown): error is EmulatorError {
  return (
    error instanceof EmulatorError &&
    error.code === 'emulator_error' &&
    MISSING_FRAMEBUFFER_RE.test(error.message)
  )
}

function toEmulatorDevice(device: SimulatorDevice): EmulatorDevice {
  return {
    backend: 'ios',
    id: device.udid,
    name: device.name,
    state: device.state === 'Booted' ? 'booted' : 'shutdown',
    detail: device.runtime,
    isAvailable: device.isAvailable !== false
  }
}
