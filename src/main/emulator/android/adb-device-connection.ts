import { EmulatorError, type EmulatorErrorCode } from '../emulator-errors'
import type { AndroidCommandRunner } from './android-command-runner'
import { adbDevicesArgs, parseAdbDevices, type AndroidAdbDeviceState } from './adb-devices'
import { parseAdbNetworkEndpoint } from './adb-network-endpoint'

export type AdbConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'unauthorized'
  | 'offline'
  | 'failed'

export type AdbConnectionStatus = {
  state: AdbConnectionState
  address: string | null
  serial: string | null
  message?: string
  errorCode?: EmulatorErrorCode
}

export type AdbDeviceConnectionOptions = {
  runner: AndroidCommandRunner
  adbPath: () => string | null
  pollIntervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_TIMEOUT_MS = 15_000

const ADB_MISSING_MESSAGE =
  'adb was not found. Install Android platform-tools, or set ANDROID_HOME / ANDROID_SDK_ROOT.'

const UNAUTHORIZED_MESSAGE =
  'The device is asking to authorize this computer. Approve the RSA key prompt on the device ' +
  '(or the cloud-phone console), then try connecting again.'

const OFFLINE_MESSAGE = 'The device is connected but reports offline. Try connecting again.'

// adb prints "connected to X" for a fresh connect and "already connected to X"
// when a connection was already live; both mean the same next step (verify via
// `devices -l`). Anything else (refused, unresolved host, ...) is a failure.
const CONNECT_SUCCESS_TEXT = /^(already )?connected to\b/im

type InFlightOp = {
  kind: 'connect' | 'disconnect'
  address: string
  promise: Promise<AdbConnectionStatus>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function validateAddress(address: string): void {
  const result = parseAdbNetworkEndpoint(address)
  if ('error' in result) {
    const code: EmulatorErrorCode =
      result.error === 'unsupported_ipv6'
        ? 'emulator_adb_address_unsupported'
        : 'emulator_adb_address_invalid'
    throw new EmulatorError(code, result.message)
  }
}

function unauthorizedStatus(address: string): AdbConnectionStatus {
  return {
    state: 'unauthorized',
    address,
    serial: address,
    message: UNAUTHORIZED_MESSAGE,
    errorCode: 'emulator_adb_unauthorized'
  }
}

function offlineStatus(address: string): AdbConnectionStatus {
  return {
    state: 'offline',
    address,
    serial: address,
    message: OFFLINE_MESSAGE,
    errorCode: 'emulator_adb_offline'
  }
}

function connectedStatus(address: string): AdbConnectionStatus {
  return { state: 'connected', address, serial: address }
}

function disconnectedStatus(address: string): AdbConnectionStatus {
  return { state: 'disconnected', address, serial: null }
}

// Owns all `adb connect`/`adb disconnect`/`adb devices -l` process I/O for
// network (host:port) devices, plus the configured-address -> runtime-serial
// mapping. adb echoes the configured address back verbatim as the serial for
// a TCP device, so matching is a plain string comparison.
export class AdbDeviceConnection {
  private readonly runner: AndroidCommandRunner
  private readonly adbPath: () => string | null
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly serialByAddress = new Map<string, string>()
  private inFlight: InFlightOp | null = null

  constructor(options: AdbDeviceConnectionOptions) {
    this.runner = options.runner
    this.adbPath = options.adbPath
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.sleep = options.sleep ?? defaultSleep
  }

  async connect(address: string): Promise<AdbConnectionStatus> {
    return this.runExclusive('connect', address, () => this.runConnect(address))
  }

  async disconnect(address: string): Promise<AdbConnectionStatus> {
    return this.runExclusive('disconnect', address, () => this.runDisconnect(address))
  }

  // Passive: a single `adb devices -l` read, never `adb connect`.
  async status(address: string): Promise<AdbConnectionStatus> {
    const adb = this.requireAdb()
    const devices = await this.readDevices(adb)
    return this.statusFromDeviceList(address, devices)
  }

  // The last-known runtime serial for a configured address, without any I/O —
  // for callers (bridge disconnect) that need to target scrcpy/session-registry
  // cleanup by serial before tearing down the adb connection itself.
  serialFor(address: string): string | null {
    return this.serialByAddress.get(address) ?? null
  }

  // The most recently connected address, for RPC disconnect/status calls that
  // don't name one explicitly. Derived from the address->serial mapping this
  // manager already owns — not new state.
  currentAddress(): string | null {
    return [...this.serialByAddress.keys()].at(-1) ?? null
  }

  // Only one connect/disconnect runs at a time. A second call for the SAME
  // address+kind shares the in-flight promise (idempotent double-click); any
  // other overlap (different address, or disconnect-during-connect) rejects
  // deterministically instead of racing two adb invocations against each
  // other. `emulator_error` (not emulator_adb_connect_failed) because this is
  // "busy", not a failed connect attempt.
  private async runExclusive(
    kind: 'connect' | 'disconnect',
    address: string,
    run: () => Promise<AdbConnectionStatus>
  ): Promise<AdbConnectionStatus> {
    const current = this.inFlight
    if (current) {
      if (current.kind === kind && current.address === address) {
        return current.promise
      }
      throw new EmulatorError(
        'emulator_error',
        `Cannot ${kind} ${address}: a ${current.kind} for ${current.address} is already in progress.`
      )
    }
    const promise = run()
    this.inFlight = { kind, address, promise }
    try {
      return await promise
    } finally {
      if (this.inFlight?.promise === promise) {
        this.inFlight = null
      }
    }
  }

  private async runConnect(address: string): Promise<AdbConnectionStatus> {
    validateAddress(address)
    const adb = this.requireAdb()
    const result = await this.runner(adb, ['connect', address])
    const output = (result.stdout || result.stderr).trim()
    if (!CONNECT_SUCCESS_TEXT.test(output)) {
      throw new EmulatorError(
        'emulator_adb_connect_failed',
        output || `adb connect ${address} failed.`
      )
    }
    return this.pollUntilConnected(adb, address)
  }

  private async runDisconnect(address: string): Promise<AdbConnectionStatus> {
    const adb = this.requireAdb()
    await this.runner(adb, ['disconnect', address])
    const devices = await this.readDevices(adb)
    const residual = devices.find((device) => device.serial === address)
    this.serialByAddress.delete(address)
    if (residual) {
      throw new EmulatorError(
        'emulator_adb_disconnect_failed',
        `${address} is still listed by "adb devices" (state: ${residual.state}).`
      )
    }
    return disconnectedStatus(address)
  }

  // Success requires an observed `device` state from `adb devices -l` — never
  // the `connect` command's exit code/text alone. `offline` right after a
  // connect is commonly transient (handshake in progress), so it keeps
  // polling instead of failing fast; `unauthorized` will not resolve without
  // the user approving the RSA key, so it returns immediately. If polling
  // exhausts the timeout, the last-seen `offline` reading is reported as a
  // status (not an error) — only a serial that never showed up at all times out.
  private async pollUntilConnected(adb: string, address: string): Promise<AdbConnectionStatus> {
    let elapsedMs = 0
    let lastState: AndroidAdbDeviceState | null = null
    for (;;) {
      const devices = await this.readDevices(adb)
      const match = devices.find((device) => device.serial === address)
      if (match?.state === 'device') {
        this.serialByAddress.set(address, address)
        return connectedStatus(address)
      }
      if (match?.state === 'unauthorized') {
        return unauthorizedStatus(address)
      }
      lastState = match?.state ?? null
      if (elapsedMs >= this.timeoutMs) {
        break
      }
      await this.sleep(this.pollIntervalMs)
      elapsedMs += this.pollIntervalMs
    }
    if (lastState === 'offline') {
      return offlineStatus(address)
    }
    throw new EmulatorError(
      'emulator_adb_connect_timeout',
      `Timed out waiting for ${address} to come online.`
    )
  }

  private statusFromDeviceList(
    address: string,
    devices: readonly { serial: string; state: AndroidAdbDeviceState }[]
  ): AdbConnectionStatus {
    const match = devices.find((device) => device.serial === address)
    if (!match) {
      this.serialByAddress.delete(address)
      return disconnectedStatus(address)
    }
    if (match.state === 'device') {
      this.serialByAddress.set(address, address)
      return connectedStatus(address)
    }
    if (match.state === 'unauthorized') {
      return unauthorizedStatus(address)
    }
    if (match.state === 'offline') {
      return offlineStatus(address)
    }
    return disconnectedStatus(address)
  }

  private async readDevices(adb: string) {
    const result = await this.runner(adb, [...adbDevicesArgs])
    return parseAdbDevices(result.stdout)
  }

  private requireAdb(): string {
    const adb = this.adbPath()
    if (!adb) {
      throw new EmulatorError('emulator_adb_missing', ADB_MISSING_MESSAGE)
    }
    return adb
  }
}
