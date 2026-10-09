import { EmulatorError } from '../emulator-errors'
import type { EmulatorDevice } from '../backends/emulator-backend'
import { buildHarmonyAvailability } from './harmony-availability-report'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'
import { HarmonySdkState } from './harmony-sdk-state'
import type { HarmonyCommandRunner } from './harmony-command-runner'
import { runProcessHarmonyCommandRunner } from './harmony-command-runner'
import {
  listHarmonyEmulatorInstances,
  type HarmonyEmulatorInstance
} from './harmony-emulator-instances'
import {
  correlateInstances,
  invertCorrelation,
  listHdcTargets,
  mergeHarmonyDevices
} from './harmony-device-inventory'
import {
  harmonyButton,
  harmonyExec,
  harmonyRotate,
  harmonySwipe,
  harmonyTap,
  harmonyTypeText,
  orientationIndex
} from './harmony-input-commands'
import type { DeviceScreenSize } from './harmony-input-mapping'
import { captureScreenDimensions } from './harmony-snapshot-capture'
import { defaultDeployedRoots, readDeployedDirNames } from './harmony-deployed-roots'
import { HarmonyDeviceScreenState } from './harmony-device-screen-state'
import { bootHarmonyDevice } from './harmony-avd-boot'
import {
  dumpHarmonyAccessibilityTree,
  installHarmonyHap,
  launchHarmonyApp
} from './harmony-capability-operations'
import type { EmulatorGesturePoint } from '../emulator-gesture-sender'

export type HarmonyDeviceControllerOptions = {
  runner?: HarmonyCommandRunner
  // Inject resolved toolchain (tests); undefined auto-discovers, null means none.
  sdk?: HarmonySdkPaths | null
  deployedRoots?: readonly string[]
  listDirectory?: (dir: string) => string[]
  bootTimeoutMs?: number
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_BOOT_TIMEOUT_MS = 180_000
const DEFAULT_POLL_INTERVAL_MS = 2_000
const REMOTE_PROBE_PATH = '/data/local/tmp/orca-orientation.jpeg'

// Owns everything device-side for the Harmony backend: discovery, boot/shutdown,
// screen size/orientation state, and input. The MJPEG stream plumbing lives in
// HarmonyStreamController.
export class HarmonyDeviceController {
  private readonly runner: HarmonyCommandRunner
  private readonly sdkState: HarmonySdkState
  private readonly deployedRoots: readonly string[]
  private readonly listDirectory: (dir: string) => string[]
  private readonly bootTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly screenState: HarmonyDeviceScreenState

  constructor(options: HarmonyDeviceControllerOptions = {}) {
    this.runner = options.runner ?? runProcessHarmonyCommandRunner
    this.sdkState = new HarmonySdkState(options.sdk !== undefined, options.sdk ?? null)
    this.deployedRoots = options.deployedRoots ?? defaultDeployedRoots()
    this.listDirectory = options.listDirectory ?? readDeployedDirNames
    this.bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.screenState = new HarmonyDeviceScreenState({
      probeSize: (connectKey) =>
        captureScreenDimensions(this.runner, this.requireSdk(), connectKey, REMOTE_PROBE_PATH),
      findLcdDimensions: (instanceName) => this.findLcdDimensions(instanceName)
    })
  }

  isSupportedOnHost(): boolean {
    return this.sdkState.resolve() !== null
  }

  checkAvailability() {
    return buildHarmonyAvailability(
      () => this.sdkState.resolve(),
      () => this.listDevices()
    )
  }

  async listDevices(): Promise<EmulatorDevice[]> {
    const sdk = this.sdkState.resolve()
    if (!sdk) {
      return []
    }
    const [instances, targets] = await Promise.all([
      this.listInstances(),
      listHdcTargets(this.runner, sdk)
    ])
    return mergeHarmonyDevices(instances, targets, correlateInstances(instances, targets))
  }

  async ownsDevice(id: string): Promise<boolean> {
    if (!this.sdkState.resolve()) {
      return false
    }
    const devices = await this.listDevices()
    return devices.some((device) => device.id === id || device.name === id)
  }

  async resolveDeviceId(deviceOrName: string): Promise<string> {
    const sdk = this.requireSdk()
    const targets = await listHdcTargets(this.runner, sdk)
    if (targets.includes(deviceOrName)) {
      return deviceOrName
    }
    const connectKey = correlateInstances(await this.listInstances(), targets).get(deviceOrName)
    if (connectKey) {
      return connectKey
    }
    throw new EmulatorError(
      'emulator_device_not_found',
      `HarmonyOS target "${deviceOrName}" is not running. Start it in DevEco Studio or boot it from Orca.`
    )
  }

  async boot(deviceOrName: string): Promise<string> {
    return bootHarmonyDevice(
      this.runner,
      this.requireSdk(),
      deviceOrName,
      await this.listInstances(),
      {
        bootTimeoutMs: this.bootTimeoutMs,
        pollIntervalMs: this.pollIntervalMs,
        sleep: this.sleep,
        relistInstances: () => this.listInstances()
      }
    )
  }

  async primeScreen(connectKey: string): Promise<void> {
    await this.screenState.prime(connectKey, await this.instanceNameForTarget(connectKey))
  }

  async tap(deviceId: string, x: number, y: number): Promise<void> {
    const connectKey = await this.resolveDeviceId(deviceId)
    await harmonyTap(
      this.runner,
      this.requireSdk(),
      connectKey,
      x,
      y,
      await this.screenState.getScreenSize(connectKey, await this.instanceNameForTarget(connectKey))
    )
  }

  async gesture(deviceId: string, points: EmulatorGesturePoint[]): Promise<void> {
    const connectKey = await this.resolveDeviceId(deviceId)
    await harmonySwipe(
      this.runner,
      this.requireSdk(),
      connectKey,
      points,
      await this.screenState.getScreenSize(connectKey, await this.instanceNameForTarget(connectKey))
    )
  }

  async typeText(deviceId: string, text: string): Promise<void> {
    await harmonyTypeText(
      this.runner,
      this.requireSdk(),
      await this.resolveDeviceId(deviceId),
      text
    )
  }

  async button(deviceId: string, name: string): Promise<void> {
    await harmonyButton(this.runner, this.requireSdk(), await this.resolveDeviceId(deviceId), name)
  }

  async rotate(deviceId: string, orientation: string): Promise<void> {
    const connectKey = await this.resolveDeviceId(deviceId)
    const instanceName = await this.instanceNameForTarget(connectKey)
    if (!instanceName) {
      throw new EmulatorError(
        'emulator_unsupported',
        'Rotation is only supported for DevEco emulator instances, not physical devices.'
      )
    }
    const targetIndex = orientationIndex(orientation)
    await harmonyRotate(
      this.runner,
      this.requireSdk(),
      instanceName,
      this.screenState.orientation(instanceName),
      targetIndex
    )
    // Phone images report success but never actually rotate: verify from a frame.
    await this.screenState.verifyRotation(connectKey, instanceName, targetIndex)
  }

  async exec(deviceId: string, command: string): Promise<unknown> {
    return harmonyExec(
      this.runner,
      this.requireSdk(),
      await this.resolveDeviceId(deviceId),
      command
    )
  }

  async installApp(
    deviceId: string,
    appPath: string,
    options?: { reinstall?: boolean }
  ): Promise<void> {
    await installHarmonyHap(
      this.runner,
      this.requireSdk(),
      await this.resolveDeviceId(deviceId),
      appPath,
      options
    )
  }

  async launchApp(deviceId: string, bundleName: string, ability?: string): Promise<void> {
    await launchHarmonyApp(
      this.runner,
      this.requireSdk(),
      await this.resolveDeviceId(deviceId),
      bundleName,
      ability
    )
  }

  async accessibilityTree(deviceId: string): Promise<unknown> {
    return dumpHarmonyAccessibilityTree(
      this.runner,
      this.requireSdk(),
      await this.resolveDeviceId(deviceId)
    )
  }

  // Power off a DevEco instance; physical targets are rejected.
  async shutdown(connectKey: string): Promise<void> {
    const instanceName = await this.instanceNameForTarget(connectKey)
    if (!instanceName) {
      throw new EmulatorError(
        'emulator_unsupported',
        'Only DevEco emulator instances can be powered off from Orca; physical devices cannot.'
      )
    }
    this.screenState.clear(connectKey, instanceName)
    const result = await this.runner(this.requireSdk().emulator, ['-stop', instanceName])
    if (result.code !== 0) {
      throw new EmulatorError(
        'emulator_error',
        `Emulator stop failed: ${(result.stderr || result.stdout).trim() || 'unknown error'}`
      )
    }
  }

  get commandRunner(): HarmonyCommandRunner {
    return this.runner
  }

  requireSdk(): HarmonySdkPaths {
    return this.sdkState.require()
  }

  private async findLcdDimensions(instanceName: string): Promise<DeviceScreenSize | null> {
    const details = (await this.listInstances()).find((entry) => entry.name === instanceName)
    return details?.lcdWidth && details.lcdHeight
      ? { width: details.lcdWidth, height: details.lcdHeight }
      : null
  }

  private async instanceNameForTarget(connectKey: string): Promise<string | null> {
    return invertCorrelation(
      correlateInstances(await this.listInstances(), [connectKey]),
      connectKey
    )
  }

  private listInstances(): Promise<HarmonyEmulatorInstance[]> {
    return listHarmonyEmulatorInstances(this.runner, this.requireSdk(), {
      deployedRoots: this.deployedRoots,
      listDirectory: this.listDirectory
    })
  }
}
