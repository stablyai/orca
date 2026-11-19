import { platform } from 'node:os'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
import { listServeSimHelperProcessesForDevice } from '../serve-sim-helper-processes'
import { ServeSimOwnedSessions } from '../serve-sim-owned-session'
import type { EmulatorBridgeOptions } from '../emulator-bridge-types'
import { sendEmulatorGestureSequence, type EmulatorGesturePoint } from '../emulator-gesture-sender'
import { requestServeSimAccessibilityTree } from '../serve-sim-accessibility-tree'
import { assertSimulatorInputNotShadowedByDeviceHub } from '../simulator-device-hub-input'
import type {
  BackendAvailability,
  EmulatorBackend,
  EmulatorBackendCapabilities,
  EmulatorDevice
} from './emulator-backend'

export class IosEmulatorBackend implements EmulatorBackend {
  readonly kind = 'ios' as const
  readonly streamCodec = 'mjpeg' as const
  readonly capabilities: EmulatorBackendCapabilities = {
    install: false,
    launch: false,
    permissions: false,
    accessibilityTree: true,
    logcat: false
  }

  private readonly sessions = new ServeSimOwnedSessions()
  private cachedServeSimExecutable: ServeSimExecutable | undefined
  private readonly waitForEndpointReady: (endpoint: string) => Promise<boolean>

  constructor(options: EmulatorBridgeOptions = {}) {
    this.waitForEndpointReady = options.waitForEndpointReady ?? waitForServeSimEndpointReady
  }

  // Defer runtime materialization and its macOS copy/xattr work until the first emulator command.
  private get serveSimExecutable(): ServeSimExecutable {
    this.cachedServeSimExecutable ??= resolveServeSimExecutable()
    return this.cachedServeSimExecutable
  }

  isSupportedOnHost(): boolean {
    return platform() === 'darwin'
  }

  async resolveDeviceId(deviceOrName: string): Promise<string> {
    return resolveSimulatorUdid(deviceOrName)
  }

  async ownsDevice(id: string): Promise<boolean> {
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

  async listSimulators(): Promise<SimulatorDevice[]> {
    return listSimulatorDevices()
  }

  async checkServeSimAvailable(): Promise<void> {
    const entry = this.serveSimExecutable.baseArgs[0]
    if (!entry || !existsSync(join(dirname(entry), 'middleware.js'))) {
      throw new EmulatorError(
        'emulator_helper_failed',
        'Cannot locate serve-sim middleware for isolated sessions.'
      )
    }
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
    await assertSimulatorInputNotShadowedByDeviceHub(udid)
    await this.execForDevice(udid, ['tap', x.toString(), y.toString(), '-d', udid])
  }

  async gesture(
    deviceId: string,
    points: EmulatorGesturePoint[],
    wsUrl: string | null
  ): Promise<void> {
    if (points.length === 0) {
      return
    }
    if (!wsUrl) {
      throw new EmulatorError('emulator_no_active', 'No active emulator stream for gesture input')
    }
    await assertSimulatorInputNotShadowedByDeviceHub(deviceId)
    if (!this.sessions.ownsEndpoint(deviceId, wsUrl)) {
      throw new EmulatorError(
        'emulator_no_active',
        'Simulator gesture session is no longer active.'
      )
    }
    await sendEmulatorGestureSequence(wsUrl, points)
  }

  async type(deviceId: string, text: string): Promise<void> {
    const udid = await this.resolveDeviceId(deviceId)
    await assertSimulatorInputNotShadowedByDeviceHub(udid)
    await this.execForDevice(udid, ['type', text, '-d', udid])
  }

  async button(deviceId: string, name: string): Promise<void> {
    const udid = await this.resolveDeviceId(deviceId)
    await this.execForDevice(udid, ['button', name, '-d', udid])
  }

  async rotate(deviceId: string, orientation: string): Promise<void> {
    const udid = await this.resolveDeviceId(deviceId)
    await this.execForDevice(udid, ['rotate', orientation, '-d', udid])
  }

  async exec(deviceId: string, command: string): Promise<unknown> {
    const udid = await this.resolveDeviceId(deviceId)
    const rawArgs = stripEmulatorTargetArgs(parseServeSimCommandArgs(command.trim()))
    if (!rawArgs[0] || rawArgs[0].startsWith('-')) {
      throw new EmulatorError('emulator_error', 'Expected a device-scoped serve-sim command.')
    }
    return this.execForDevice(udid, [...rawArgs, '-d', udid], { json: true })
  }

  async accessibilityTree(deviceId: string, axUrl?: string): Promise<unknown> {
    if (!axUrl || !this.sessions.ownsEndpoint(deviceId, axUrl)) {
      throw new EmulatorError(
        'emulator_no_active',
        'No active iOS emulator AX endpoint — attach the simulator first.'
      )
    }
    return requestServeSimAccessibilityTree(axUrl)
  }

  async startSession(
    deviceId: string,
    assertOpen: () => void = () => {}
  ): Promise<EmulatorSessionInfo> {
    const udid = await this.resolveDeviceId(deviceId)
    assertOpen()
    return this.sessions.start(
      udid,
      this.serveSimExecutable,
      async () => {
        const existing = await listServeSimHelperProcessesForDevice(udid, { includeOrphaned: true })
        if (existing.length > 0) {
          throw new EmulatorError(
            'emulator_helper_failed',
            `Simulator ${udid} already has an external serve-sim helper.`
          )
        }
        assertOpen()
        await ensureSimulatorBooted(udid, assertOpen)
        assertOpen()
      },
      (info) => this.waitForEndpointReady(info.streamUrl),
      assertOpen
    )
  }

  async stopHelperForDevice(
    deviceId: string,
    options: {
      helperPid?: number
      includeOrphaned?: boolean
      shutdownDevice?: boolean
      releaseOnShutdownFailure?: boolean
      assertShutdownAllowed?: () => void
      onHelperStopped?: () => void
    } = {}
  ): Promise<void> {
    await this.sessions.stop(
      deviceId,
      options.helperPid,
      options.shutdownDevice
        ? (markIssued) => {
            options.assertShutdownAllowed?.()
            markIssued()
            return this.shutdownDevice(deviceId)
          }
        : undefined,
      options.releaseOnShutdownFailure,
      options.onHelperStopped
    )
  }

  async stopOwnedHelpers(): Promise<void> {
    await this.sessions.stopOwnedHelpers()
  }

  async shutdownDevice(deviceId: string): Promise<void> {
    await shutdownSimulatorDevice(deviceId)
  }

  async isSessionReusable(info: EmulatorSessionInfo): Promise<boolean> {
    try {
      return (
        this.sessions.owns(info) &&
        (await this.waitForEndpointReady(info.streamUrl)) &&
        this.sessions.owns(info)
      )
    } catch {
      return false
    }
  }

  private async execForDevice(
    udid: string,
    args: string[],
    options?: { json?: boolean; timeoutMs?: number }
  ): Promise<unknown> {
    return execServeSimCommand(this.serveSimExecutable, args, {
      ...options,
      stateRoot: this.sessions.stateRoot(udid)
    })
  }

  private async execServeSim(
    args: string[],
    options?: { json?: boolean; timeoutMs?: number }
  ): Promise<unknown> {
    return execServeSimCommand(this.serveSimExecutable, args, options)
  }
}

function toEmulatorDevice(device: SimulatorDevice): EmulatorDevice {
  return {
    backend: 'ios',
    id: device.udid,
    name: device.name,
    state:
      device.state === 'Booted' ? 'booted' : device.state === 'Booting' ? 'booting' : 'shutdown',
    detail: device.runtime,
    lastUsedAt: device.lastUsedAt,
    availabilityError: device.availabilityError,
    isAvailable: device.isAvailable !== false
  }
}
