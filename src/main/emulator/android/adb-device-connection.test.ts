import { describe, expect, it, vi } from 'vitest'
import { AdbDeviceConnection } from './adb-device-connection'
import type { AndroidCommandResult, AndroidCommandRunner } from './android-command-runner'

const ADB = '/sdk/adb'
const ADDRESS = '192.168.1.50:5555'

function ok(stdout: string, code = 0): AndroidCommandResult {
  return { stdout, stderr: '', code }
}

function fail(stderr: string, code = 1): AndroidCommandResult {
  return { stdout: '', stderr, code }
}

function devicesOutput(...lines: string[]): string {
  return ['List of devices attached', ...lines].join('\n')
}

type Script = {
  connect?: AndroidCommandResult[]
  disconnect?: AndroidCommandResult[]
  // Raw `adb devices -l` stdout per poll; the last entry repeats forever (so
  // a "stuck" state needs only one scripted line).
  devices?: string[]
}

// A scripted fake AndroidCommandRunner: `connect`/`disconnect` responses are
// consumed once per call (queue), `devices -l` responses are consumed in
// order but the last entry repeats forever. Records every call for assertions.
function scriptedRunner(script: Script): {
  runner: AndroidCommandRunner
  calls: { binary: string; args: string[] }[]
} {
  const devices = [...(script.devices ?? [])]
  const connect = [...(script.connect ?? [])]
  const disconnect = [...(script.disconnect ?? [])]
  const calls: { binary: string; args: string[] }[] = []
  const runner: AndroidCommandRunner = async (binary, args) => {
    calls.push({ binary, args: [...args] })
    if (args[0] === 'connect') {
      return connect.shift() ?? ok(`connected to ${args[1]}`)
    }
    if (args[0] === 'disconnect') {
      return disconnect.shift() ?? ok(`disconnected ${args[1]}`)
    }
    if (args[0] === 'devices') {
      const stdout = devices.length > 1 ? devices.shift()! : (devices[0] ?? devicesOutput())
      return ok(stdout)
    }
    return ok('')
  }
  return { runner, calls }
}

function noopSleep(): (ms: number) => Promise<void> {
  return async () => {}
}

function manager(
  script: Script,
  options: { adbPath?: string | null; pollIntervalMs?: number; timeoutMs?: number } = {}
): { manager: AdbDeviceConnection; calls: { binary: string; args: string[] }[] } {
  const { runner, calls } = scriptedRunner(script)
  const adb = options.adbPath === undefined ? ADB : options.adbPath
  return {
    manager: new AdbDeviceConnection({
      runner,
      adbPath: () => adb,
      pollIntervalMs: options.pollIntervalMs ?? 10,
      timeoutMs: options.timeoutMs ?? 30,
      sleep: noopSleep()
    }),
    calls
  }
}

describe('AdbDeviceConnection.connect', () => {
  it('succeeds once devices -l reports state=device, after transitioning through offline', async () => {
    const { manager: mgr, calls } = manager({
      connect: [ok(`connected to ${ADDRESS}`)],
      devices: [devicesOutput(`${ADDRESS}\toffline`), devicesOutput(`${ADDRESS}\tdevice`)]
    })

    const status = await mgr.connect(ADDRESS)

    expect(status).toEqual({ state: 'connected', address: ADDRESS, serial: ADDRESS })
    const connectCalls = calls.filter((call) => call.args[0] === 'connect')
    expect(connectCalls).toHaveLength(1)
    const deviceCalls = calls.filter((call) => call.args[0] === 'devices')
    expect(deviceCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('treats "already connected to" the same as a fresh connect and still verifies devices -l', async () => {
    const { manager: mgr, calls } = manager({
      connect: [ok(`already connected to ${ADDRESS}`)],
      devices: [devicesOutput(`${ADDRESS}\tdevice`)]
    })

    const status = await mgr.connect(ADDRESS)

    expect(status.state).toBe('connected')
    expect(calls.some((call) => call.args[0] === 'devices')).toBe(true)
  })

  it('returns an unauthorized status with actionable guidance', async () => {
    const { manager: mgr } = manager({
      connect: [ok(`connected to ${ADDRESS}`)],
      devices: [devicesOutput(`${ADDRESS}\tunauthorized`)]
    })

    const status = await mgr.connect(ADDRESS)

    expect(status.state).toBe('unauthorized')
    expect(status.errorCode).toBe('emulator_adb_unauthorized')
    expect(status.message).toMatch(/approve/i)
  })

  it('reports offline status (not an error) when the device stays offline through the poll timeout', async () => {
    const { manager: mgr } = manager({
      connect: [ok(`connected to ${ADDRESS}`)],
      devices: [devicesOutput(`${ADDRESS}\toffline`)]
    })

    const status = await mgr.connect(ADDRESS)

    // Success requires state=device; a device stuck at offline must never be
    // reported as connected, even though it appeared in `adb devices -l`.
    expect(status.state).toBe('offline')
    expect(status.state).not.toBe('connected')
    expect(status.errorCode).toBe('emulator_adb_offline')
  })

  it('rejects with emulator_adb_connect_failed when adb refuses the connection', async () => {
    const { manager: mgr, calls } = manager({
      connect: [fail(`failed to connect to ${ADDRESS}: Connection refused`)]
    })

    await expect(mgr.connect(ADDRESS)).rejects.toMatchObject({
      code: 'emulator_adb_connect_failed',
      message: expect.stringContaining('Connection refused')
    })
    // Never polls devices -l after a refused connect.
    expect(calls.some((call) => call.args[0] === 'devices')).toBe(false)
  })

  it('rejects with emulator_adb_connect_timeout when the address never appears in adb devices -l', async () => {
    const { manager: mgr } = manager({
      connect: [ok(`connected to ${ADDRESS}`)],
      devices: [devicesOutput('R58N123ABC\tdevice')]
    })

    await expect(mgr.connect(ADDRESS)).rejects.toMatchObject({
      code: 'emulator_adb_connect_timeout'
    })
  })

  it('rejects with emulator_adb_missing when no adb binary is configured, without invoking the runner', async () => {
    const { manager: mgr, calls } = manager({}, { adbPath: null })

    await expect(mgr.connect(ADDRESS)).rejects.toMatchObject({ code: 'emulator_adb_missing' })
    expect(calls).toHaveLength(0)
  })

  it('rejects an invalid address before touching the runner', async () => {
    const { manager: mgr, calls } = manager({})

    await expect(mgr.connect('not-an-address')).rejects.toMatchObject({
      code: 'emulator_adb_address_invalid'
    })
    expect(calls).toHaveLength(0)
  })

  it('rejects bracketed IPv6 as unsupported before touching the runner', async () => {
    const { manager: mgr, calls } = manager({})

    await expect(mgr.connect('[::1]:5555')).rejects.toMatchObject({
      code: 'emulator_adb_address_unsupported'
    })
    expect(calls).toHaveLength(0)
  })
})

describe('AdbDeviceConnection.disconnect', () => {
  it('disconnects and confirms the serial left adb devices', async () => {
    const { manager: mgr } = manager({
      disconnect: [ok(`disconnected ${ADDRESS}`)],
      devices: [devicesOutput()]
    })

    const status = await mgr.disconnect(ADDRESS)

    expect(status).toEqual({ state: 'disconnected', address: ADDRESS, serial: null })
  })

  it('fails with emulator_adb_disconnect_failed when the serial remains listed', async () => {
    const { manager: mgr } = manager({
      disconnect: [ok(`disconnected ${ADDRESS}`)],
      devices: [devicesOutput(`${ADDRESS}\tdevice`)]
    })

    await expect(mgr.disconnect(ADDRESS)).rejects.toMatchObject({
      code: 'emulator_adb_disconnect_failed',
      message: expect.stringContaining(ADDRESS)
    })
  })

  it('is idempotent: disconnecting an already-disconnected address still succeeds', async () => {
    const { manager: mgr } = manager({
      disconnect: [ok(`disconnected ${ADDRESS}`), ok(`no such device ${ADDRESS}`)],
      devices: [devicesOutput()]
    })

    const first = await mgr.disconnect(ADDRESS)
    const second = await mgr.disconnect(ADDRESS)

    expect(first).toEqual({ state: 'disconnected', address: ADDRESS, serial: null })
    expect(second).toEqual({ state: 'disconnected', address: ADDRESS, serial: null })
  })

  it('rejects with emulator_adb_missing when no adb binary is configured', async () => {
    const { manager: mgr } = manager({}, { adbPath: null })

    await expect(mgr.disconnect(ADDRESS)).rejects.toMatchObject({ code: 'emulator_adb_missing' })
  })
})

describe('AdbDeviceConnection.status', () => {
  it('is passive: it never issues adb connect', async () => {
    const { manager: mgr, calls } = manager({
      devices: [devicesOutput(`${ADDRESS}\tdevice`)]
    })

    const status = await mgr.status(ADDRESS)

    expect(status.state).toBe('connected')
    expect(calls.some((call) => call.args[0] === 'connect')).toBe(false)
  })

  it('reports disconnected when the address is absent from adb devices -l', async () => {
    const { manager: mgr } = manager({ devices: [devicesOutput('R58N123ABC\tdevice')] })

    expect(await mgr.status(ADDRESS)).toEqual({
      state: 'disconnected',
      address: ADDRESS,
      serial: null
    })
  })

  it('surfaces unauthorized and offline from a single read', async () => {
    const { manager: unauthorizedMgr } = manager({
      devices: [devicesOutput(`${ADDRESS}\tunauthorized`)]
    })
    const { manager: offlineMgr } = manager({ devices: [devicesOutput(`${ADDRESS}\toffline`)] })

    expect((await unauthorizedMgr.status(ADDRESS)).state).toBe('unauthorized')
    expect((await offlineMgr.status(ADDRESS)).state).toBe('offline')
  })
})

describe('AdbDeviceConnection single in-flight semantics', () => {
  it('shares one in-flight connect promise between concurrent same-address callers', async () => {
    let resolveConnect: (result: AndroidCommandResult) => void = () => {}
    const connectGate = new Promise<AndroidCommandResult>((resolve) => {
      resolveConnect = resolve
    })
    const calls: { binary: string; args: string[] }[] = []
    const runner: AndroidCommandRunner = async (binary, args) => {
      calls.push({ binary, args: [...args] })
      if (args[0] === 'connect') {
        return connectGate
      }
      if (args[0] === 'devices') {
        return ok(devicesOutput(`${ADDRESS}\tdevice`))
      }
      return ok('')
    }
    const mgr = new AdbDeviceConnection({
      runner,
      adbPath: () => ADB,
      pollIntervalMs: 10,
      timeoutMs: 30,
      sleep: noopSleep()
    })

    const first = mgr.connect(ADDRESS)
    const second = mgr.connect(ADDRESS)
    resolveConnect(ok(`connected to ${ADDRESS}`))
    const [firstStatus, secondStatus] = await Promise.all([first, second])

    expect(firstStatus).toEqual(secondStatus)
    expect(calls.filter((call) => call.args[0] === 'connect')).toHaveLength(1)
  })

  it('deterministically rejects a connect for a different address while one is in flight', async () => {
    let resolveConnect: (result: AndroidCommandResult) => void = () => {}
    const connectGate = new Promise<AndroidCommandResult>((resolve) => {
      resolveConnect = resolve
    })
    const runner: AndroidCommandRunner = async (_binary, args) => {
      if (args[0] === 'connect') {
        return connectGate
      }
      return ok(devicesOutput(`${ADDRESS}\tdevice`))
    }
    const mgr = new AdbDeviceConnection({
      runner,
      adbPath: () => ADB,
      pollIntervalMs: 10,
      timeoutMs: 30,
      sleep: noopSleep()
    })

    const first = mgr.connect(ADDRESS)
    await expect(mgr.connect('10.0.0.9:5555')).rejects.toMatchObject({ code: 'emulator_error' })

    resolveConnect(ok(`connected to ${ADDRESS}`))
    await expect(first).resolves.toMatchObject({ state: 'connected' })
  })

  it('deterministically rejects a disconnect issued while a connect for the same address is in flight', async () => {
    let resolveConnect: (result: AndroidCommandResult) => void = () => {}
    const connectGate = new Promise<AndroidCommandResult>((resolve) => {
      resolveConnect = resolve
    })
    const runner: AndroidCommandRunner = async (_binary, args) => {
      if (args[0] === 'connect') {
        return connectGate
      }
      return ok(devicesOutput(`${ADDRESS}\tdevice`))
    }
    const mgr = new AdbDeviceConnection({
      runner,
      adbPath: () => ADB,
      pollIntervalMs: 10,
      timeoutMs: 30,
      sleep: noopSleep()
    })

    const first = mgr.connect(ADDRESS)
    await expect(mgr.disconnect(ADDRESS)).rejects.toMatchObject({ code: 'emulator_error' })

    resolveConnect(ok(`connected to ${ADDRESS}`))
    await expect(first).resolves.toMatchObject({ state: 'connected' })
  })
})

describe('AdbDeviceConnection poll timing', () => {
  it('sleeps between polls using the injected sleep and the configured interval', async () => {
    const sleep = vi.fn(async () => {})
    const { runner } = scriptedRunner({
      connect: [ok(`connected to ${ADDRESS}`)],
      devices: [devicesOutput(`${ADDRESS}\toffline`), devicesOutput(`${ADDRESS}\tdevice`)]
    })
    const mgr = new AdbDeviceConnection({
      runner,
      adbPath: () => ADB,
      pollIntervalMs: 25,
      timeoutMs: 500,
      sleep
    })

    await mgr.connect(ADDRESS)

    expect(sleep).toHaveBeenCalledWith(25)
  })
})
