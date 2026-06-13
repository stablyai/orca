import { execFile } from 'child_process'
import type { ExecFileException } from 'child_process'
import { platform } from 'os'
import { EmulatorError } from './emulator-errors'
import { execServeSimCommand, type ServeSimExecutable } from './serve-sim-execution'

export type SimulatorDevice = {
  name: string
  udid: string
  state: string
  runtime: string
  isAvailable?: boolean
}

type SimctlDevice = {
  name?: string
  udid?: string
  state?: string
  isAvailable?: boolean
}

type SimctlDeviceList = {
  devices?: Record<string, SimctlDevice[]>
}

const UDID_RE = /^[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}$/i
const SIMCTL_UNAVAILABLE_MESSAGE =
  'Xcode Simulator tools are unavailable. Install full Xcode, open it once, then select it with `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`.'

function parseSimctlDevices(stdout: string): SimulatorDevice[] {
  const data = JSON.parse(stdout || '{}') as SimctlDeviceList
  const devices: SimulatorDevice[] = []
  for (const [runtime, runtimeDevices] of Object.entries(data.devices ?? {})) {
    for (const device of runtimeDevices) {
      if (!device.udid) {
        continue
      }
      devices.push({
        name: device.name ?? device.udid,
        udid: device.udid,
        state: device.state ?? 'unknown',
        runtime,
        isAvailable: device.isAvailable
      })
    }
  }
  return devices
}

function mapSimctlError(error: ExecFileException, stderr?: string | Buffer): EmulatorError {
  const raw = `${error.message}\n${stderr?.toString() ?? ''}`
  const lower = raw.toLowerCase()
  if (
    error.code === 'ENOENT' ||
    (lower.includes('unable to find utility') && lower.includes('simctl')) ||
    lower.includes('not a developer tool')
  ) {
    // Why: xcrun exposes setup problems as raw execFile text; UI and CLI need
    // the actionable Xcode fix instead of "Command failed: xcrun ...".
    return new EmulatorError('emulator_simctl_unavailable', SIMCTL_UNAVAILABLE_MESSAGE)
  }
  return new EmulatorError('emulator_error', raw.trim() || 'xcrun simctl command failed.')
}

export async function listSimulatorDevices(): Promise<SimulatorDevice[]> {
  if (platform() !== 'darwin') {
    return []
  }
  return new Promise((resolve, reject) => {
    execFile(
      'xcrun',
      ['simctl', 'list', 'devices', '-j'],
      { timeout: 15_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(mapSimctlError(error, stderr))
          return
        }
        try {
          resolve(parseSimctlDevices(stdout))
        } catch (parseError) {
          reject(parseError)
        }
      }
    )
  })
}

export async function resolveSimulatorUdid(
  deviceOrName: string,
  serveSimExecutable: ServeSimExecutable
): Promise<string> {
  if (UDID_RE.test(deviceOrName)) {
    return deviceOrName
  }
  try {
    const devices = await listSimulatorDevices()
    const needle = deviceOrName.toLowerCase()
    const match = devices.find(
      (device) => device.name.toLowerCase().includes(needle) || device.udid === deviceOrName
    )
    if (match) {
      return match.udid
    }
  } catch {
    // serve-sim --list resolves names in some paths; use it as a last fallback.
  }

  try {
    const raw = await execServeSimCommand(serveSimExecutable, ['--list', '-q'], {
      json: true,
      timeoutMs: 10_000
    })
    if (raw && typeof raw === 'object') {
      const device = (raw as { device?: unknown }).device
      if (typeof device === 'string' && device.toLowerCase().includes(deviceOrName.toLowerCase())) {
        return device
      }
    }
  } catch {}
  return deviceOrName
}

export async function ensureSimulatorBooted(udid: string): Promise<void> {
  if (platform() !== 'darwin') {
    throw new EmulatorError(
      'emulator_not_macos',
      'iOS Simulator requires macOS with Xcode Command Line Tools.'
    )
  }
  const devices = await listSimulatorDevices()
  const device = devices.find((candidate) => candidate.udid === udid)
  if (!device) {
    throw new EmulatorError(
      'emulator_device_not_found',
      `Simulator ${udid} not found. Create one via Xcode > Window > Devices and Simulators.`
    )
  }
  if (device.state === 'Booted') {
    return
  }

  try {
    await new Promise<void>((resolve, reject) => {
      execFile('xcrun', ['simctl', 'boot', udid], { timeout: 45_000 }, (error, _stdout, stderr) => {
        if (error) {
          const message = error.message.toLowerCase()
          if (message.includes('booted') || message.includes('current state')) {
            resolve()
            return
          }
          reject(mapSimctlError(error, stderr))
          return
        }
        resolve()
      })
    })
  } catch {
    // Boot can already be in progress; the poll below is the source of truth.
  }

  const deadline = Date.now() + 22_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700))
    try {
      const fresh = await listSimulatorDevices()
      if (fresh.find((candidate) => candidate.udid === udid)?.state === 'Booted') {
        return
      }
    } catch {
      // Ignore transient simctl failures while CoreSimulator is booting.
    }
  }
}

export async function shutdownSimulatorDevice(udid: string): Promise<void> {
  if (platform() !== 'darwin') {
    throw new EmulatorError(
      'emulator_not_macos',
      'iOS Simulator requires macOS with Xcode Command Line Tools.'
    )
  }

  await new Promise<void>((resolve, reject) => {
    execFile(
      'xcrun',
      ['simctl', 'shutdown', udid],
      { timeout: 30_000 },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve()
          return
        }
        const message = error.message.toLowerCase()
        if (message.includes('shutdown') || message.includes('current state')) {
          resolve()
          return
        }
        reject(mapSimctlError(error, stderr))
      }
    )
  })
}
