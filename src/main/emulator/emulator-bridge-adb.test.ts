import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmulatorSessionInfo } from './emulator-types'
import type { SimulatorDevice } from './simctl-simulator-devices'
import type { ServeSimHelperProcess } from './serve-sim-helper-processes'

const {
  execServeSimCommandMock,
  killServeSimHelperProcessesForDeviceMock,
  listSimulatorDevicesMock,
  listServeSimHelperProcessesForDeviceMock,
  discoverAndroidSdkFromHostMock,
  androidCommandRunnerMock
} = vi.hoisted(() => ({
  execServeSimCommandMock: vi.fn(async () => ({})),
  killServeSimHelperProcessesForDeviceMock: vi.fn(async () => {}),
  listSimulatorDevicesMock: vi.fn(async (): Promise<SimulatorDevice[]> => []),
  listServeSimHelperProcessesForDeviceMock: vi.fn(async (): Promise<ServeSimHelperProcess[]> => []),
  discoverAndroidSdkFromHostMock: vi.fn((): unknown => null),
  androidCommandRunnerMock: vi.fn(async (_binary: string, _args: readonly string[]) => ({
    stdout: '',
    stderr: '',
    code: 0
  }))
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/mock-userdata' },
  net: { fetch: vi.fn() }
}))

vi.mock('./serve-sim-execution', () => ({
  execServeSimCommand: execServeSimCommandMock,
  parseServeSimCommandArgs: vi.fn(() => []),
  resolveServeSimExecutable: vi.fn(() => ({ command: '/serve-sim', env: {} })),
  stripEmulatorTargetArgs: vi.fn((args: string[]) => args)
}))

vi.mock('./simctl-simulator-devices', () => ({
  ensureSimulatorBooted: vi.fn(async () => {}),
  listSimulatorDevices: listSimulatorDevicesMock,
  resolveSimulatorUdid: vi.fn(async (device: string) => device),
  shutdownSimulatorDevice: vi.fn(async () => {})
}))

vi.mock('./serve-sim-helper-processes', () => ({
  killServeSimHelperProcessesForDevice: killServeSimHelperProcessesForDeviceMock,
  listServeSimHelperProcessesForDevice: listServeSimHelperProcessesForDeviceMock
}))

vi.mock('./simulator-app-visibility', () => ({
  hideNativeSimulatorApp: vi.fn(async () => {})
}))

vi.mock('./android/android-sdk-host-discovery', () => ({
  discoverAndroidSdkFromHost: discoverAndroidSdkFromHostMock,
  setConfiguredAndroidSdkPath: () => {}
}))

vi.mock('./android/android-command-runner', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, execFileAndroidCommandRunner: androidCommandRunnerMock }
})

vi.mock('os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, platform: () => 'darwin' }
})

import { EmulatorBridge } from './emulator-bridge'
import { RuntimeEmulatorCommands } from '../runtime/orca-runtime-emulator'

function session(deviceUdid: string): EmulatorSessionInfo {
  return {
    deviceUdid,
    streamUrl: `http://127.0.0.1:3100/${deviceUdid}`,
    wsUrl: `ws://127.0.0.1:3100/${deviceUdid}`,
    axUrl: `http://127.0.0.1:3100/${deviceUdid}/ax`,
    helperPid: 1234,
    streamCodec: 'mjpeg'
  }
}

function mockPlatformToolsSdk(): void {
  discoverAndroidSdkFromHostMock.mockReturnValue({
    sdkRoot: '/sdk',
    adb: '/sdk/adb',
    avdTools: null
  })
}

describe('EmulatorBridge ADB network devices', () => {
  beforeEach(() => {
    execServeSimCommandMock.mockReset()
    execServeSimCommandMock.mockImplementation(async () => ({}))
    listSimulatorDevicesMock.mockReset()
    listSimulatorDevicesMock.mockImplementation(async () => [])
    killServeSimHelperProcessesForDeviceMock.mockReset()
    listServeSimHelperProcessesForDeviceMock.mockReset()
    listServeSimHelperProcessesForDeviceMock.mockImplementation(async () => [
      { pid: 1234, command: 'serve-sim-bin device-1' }
    ])
    discoverAndroidSdkFromHostMock.mockReset()
    discoverAndroidSdkFromHostMock.mockReturnValue(null)
    androidCommandRunnerMock.mockReset()
    androidCommandRunnerMock.mockImplementation(async () => ({ stdout: '', stderr: '', code: 0 }))
  })

  it('never sends emu kill to a TCP or USB android device during destroyAllSessions/app-quit', async () => {
    mockPlatformToolsSdk()
    androidCommandRunnerMock.mockImplementation(async (binary: string, args: readonly string[]) => {
      if (binary === '/sdk/adb' && args.join(' ') === 'devices -l') {
        return {
          stdout:
            'List of devices attached\n' +
            '127.0.0.1:5555\tdevice\n' +
            'cloud.internal:5555\tdevice\n' +
            'R58N123ABC\tdevice',
          stderr: '',
          code: 0
        }
      }
      return { stdout: '', stderr: '', code: 0 }
    })
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-tcp', session('127.0.0.1:5555'), {
      managed: true,
      backend: 'android'
    })
    bridge.registerActiveEmulator('wt-cloud', session('cloud.internal:5555'), {
      managed: true,
      backend: 'android'
    })
    bridge.registerActiveEmulator('wt-usb', session('R58N123ABC'), {
      managed: true,
      backend: 'android'
    })

    await bridge.destroyAllSessions()

    for (const call of androidCommandRunnerMock.mock.calls) {
      expect(call[1].join(' ')).not.toContain('emu kill')
    }
    expect(bridge.getActiveForWorktree('wt-tcp')).toBeNull()
    expect(bridge.getActiveForWorktree('wt-cloud')).toBeNull()
    expect(bridge.getActiveForWorktree('wt-usb')).toBeNull()

    androidCommandRunnerMock.mockClear()
    bridge.registerActiveEmulator('wt-tcp', session('127.0.0.1:5555'), {
      managed: true,
      backend: 'android'
    })

    await bridge.onAppQuit()

    for (const call of androidCommandRunnerMock.mock.calls) {
      expect(call[1].join(' ')).not.toContain('emu kill')
    }
  })

  it('stops the scrcpy helper and clears the session registry before adb disconnect', async () => {
    const ADDRESS = '127.0.0.1:5555'
    mockPlatformToolsSdk()
    let disconnected = false
    androidCommandRunnerMock.mockImplementation(async (binary: string, args: readonly string[]) => {
      if (binary === '/sdk/adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: disconnected
            ? 'List of devices attached'
            : `List of devices attached\n${ADDRESS}\tdevice`,
          stderr: '',
          code: 0
        }
      }
      if (binary === '/sdk/adb' && args[0] === 'disconnect') {
        disconnected = true
        return { stdout: `disconnected ${ADDRESS}`, stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session(ADDRESS), { managed: true, backend: 'android' })

    const status = await bridge.adbDisconnect(ADDRESS)

    expect(status).toEqual({ state: 'disconnected', address: ADDRESS, serial: null })
    expect(bridge.getActiveForWorktree('wt-1')).toBeNull()
    const argLists = androidCommandRunnerMock.mock.calls.map((call) => call[1] as string[])
    const forwardIndex = argLists.findIndex((args) => args.includes('forward'))
    const disconnectIndex = argLists.findIndex((args) => args[0] === 'disconnect')
    expect(forwardIndex).toBeGreaterThanOrEqual(0)
    expect(disconnectIndex).toBeGreaterThan(forwardIndex)
  })

  it('never issues adb disconnect on pane-close (stopActiveForWorktree) or app quit', async () => {
    const ADDRESS = '127.0.0.1:5555'
    mockPlatformToolsSdk()
    androidCommandRunnerMock.mockImplementation(async (binary: string, args: readonly string[]) => {
      if (binary === '/sdk/adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: `List of devices attached\n${ADDRESS}\tdevice`,
          stderr: '',
          code: 0
        }
      }
      return { stdout: '', stderr: '', code: 0 }
    })
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session(ADDRESS), { managed: true, backend: 'android' })

    await bridge.stopActiveForWorktree('wt-1', { shutdownDevice: true })
    for (const call of androidCommandRunnerMock.mock.calls) {
      expect(call[1][0]).not.toBe('disconnect')
    }

    androidCommandRunnerMock.mockClear()
    bridge.registerActiveEmulator('wt-2', session(ADDRESS), { managed: true, backend: 'android' })
    await bridge.onAppQuit()
    for (const call of androidCommandRunnerMock.mock.calls) {
      expect(call[1][0]).not.toBe('disconnect')
    }
  })

  it('routes an offline ADB network address to the android backend, not the darwin/iOS fallback', async () => {
    const bridge = new EmulatorBridge()
    const result = await bridge.runCapability(
      'install',
      { device: '127.0.0.1:5555' },
      async () => 'routed-to-android'
    )
    expect(result).toBe('routed-to-android')
    expect(listSimulatorDevicesMock).not.toHaveBeenCalled()
    expect(execServeSimCommandMock).not.toHaveBeenCalled()
  })

  it('keeps the existing host-platform fallback for an unrecognized non-network identifier', async () => {
    const bridge = new EmulatorBridge()
    await expect(
      bridge.runCapability('install', { device: 'unknown-device' }, async () => 'unused')
    ).rejects.toMatchObject({ code: 'emulator_unsupported' })
  })
})

describe('RuntimeEmulatorCommands ADB device connection', () => {
  const ADDRESS = '192.168.1.50:5555'

  beforeEach(() => {
    discoverAndroidSdkFromHostMock.mockReset()
    mockPlatformToolsSdk()
    androidCommandRunnerMock.mockReset()
    androidCommandRunnerMock.mockImplementation(async () => ({ stdout: '', stderr: '', code: 0 }))
  })

  function commands(bridge: EmulatorBridge): RuntimeEmulatorCommands {
    return new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveEmulatorWorkspaceId: vi.fn(async () => 'wt-1'),
      resolveEmulatorCleanupWorkspaceId: vi.fn(async () => 'wt-1'),
      getAuthoritativeWindow: () => ({ webContents: { send: vi.fn() } }) as never,
      getSettings: () => ({
        mobileEmulatorEnabled: true,
        mobileEmulatorDefaultDeviceUdid: null
      })
    })
  }

  it('delegates a successful connect to the bridge and returns its status verbatim', async () => {
    androidCommandRunnerMock.mockImplementation(async (binary: string, args: readonly string[]) => {
      if (binary === '/sdk/adb' && args[0] === 'connect') {
        return { stdout: `connected to ${ADDRESS}`, stderr: '', code: 0 }
      }
      if (binary === '/sdk/adb' && args.join(' ') === 'devices -l') {
        return { stdout: `List of devices attached\n${ADDRESS}\tdevice`, stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })
    const bridge = new EmulatorBridge()

    const status = await commands(bridge).emulatorAdbConnect({ address: ADDRESS, worktree: 'wt-1' })

    expect(status).toEqual({ state: 'connected', address: ADDRESS, serial: ADDRESS })
  })

  it('rejects a grammar-invalid address with emulator_adb_address_invalid, without touching adb', async () => {
    const bridge = new EmulatorBridge()

    await expect(
      commands(bridge).emulatorAdbConnect({ address: 'not-an-address' })
    ).rejects.toMatchObject({ code: 'emulator_adb_address_invalid' })
    expect(androidCommandRunnerMock).not.toHaveBeenCalled()
  })

  it('surfaces an unauthorized status (not a thrown error) when the device needs authorization', async () => {
    androidCommandRunnerMock.mockImplementation(async (binary: string, args: readonly string[]) => {
      if (binary === '/sdk/adb' && args[0] === 'connect') {
        return { stdout: `connected to ${ADDRESS}`, stderr: '', code: 0 }
      }
      if (binary === '/sdk/adb' && args.join(' ') === 'devices -l') {
        return { stdout: `List of devices attached\n${ADDRESS}\tunauthorized`, stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })
    const bridge = new EmulatorBridge()

    const status = await commands(bridge).emulatorAdbConnect({ address: ADDRESS })

    expect(status.state).toBe('unauthorized')
    expect(status.errorCode).toBe('emulator_adb_unauthorized')
  })

  it('disconnects the last-connected address when the RPC call omits one', async () => {
    let connected = true
    androidCommandRunnerMock.mockImplementation(async (binary: string, args: readonly string[]) => {
      if (binary !== '/sdk/adb') {
        return { stdout: '', stderr: '', code: 0 }
      }
      if (args[0] === 'connect') {
        return { stdout: `connected to ${ADDRESS}`, stderr: '', code: 0 }
      }
      if (args[0] === 'disconnect') {
        connected = false
        return { stdout: `disconnected ${ADDRESS}`, stderr: '', code: 0 }
      }
      if (args.join(' ') === 'devices -l') {
        return {
          stdout: connected
            ? `List of devices attached\n${ADDRESS}\tdevice`
            : 'List of devices attached',
          stderr: '',
          code: 0
        }
      }
      return { stdout: '', stderr: '', code: 0 }
    })
    const bridge = new EmulatorBridge()
    const cmds = commands(bridge)
    await cmds.emulatorAdbConnect({ address: ADDRESS })

    const status = await cmds.emulatorAdbDisconnect({})

    expect(status).toEqual({ state: 'disconnected', address: ADDRESS, serial: null })
  })

  it('fails typed when disconnect has no address and nothing has ever connected', async () => {
    const bridge = new EmulatorBridge()

    await expect(commands(bridge).emulatorAdbDisconnect({})).rejects.toMatchObject({
      code: 'emulator_adb_not_connected'
    })
    expect(androidCommandRunnerMock).not.toHaveBeenCalled()
  })

  it('reports disconnected for a status call with no address and nothing ever connected, without any adb I/O', async () => {
    const bridge = new EmulatorBridge()

    const status = await commands(bridge).emulatorAdbConnectionStatus({})

    expect(status).toEqual({ state: 'disconnected', address: null, serial: null })
    expect(androidCommandRunnerMock).not.toHaveBeenCalled()
  })

  it('resolves two overlapping connect calls to a single underlying adb connect invocation', async () => {
    let resolveConnect: (result: {
      stdout: string
      stderr: string
      code: number
    }) => void = () => {}
    const connectGate = new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      resolveConnect = resolve
    })
    androidCommandRunnerMock.mockImplementation(async (binary: string, args: readonly string[]) => {
      if (binary !== '/sdk/adb') {
        return { stdout: '', stderr: '', code: 0 }
      }
      if (args[0] === 'connect') {
        return connectGate
      }
      if (args.join(' ') === 'devices -l') {
        return { stdout: `List of devices attached\n${ADDRESS}\tdevice`, stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })
    const bridge = new EmulatorBridge()
    const cmds = commands(bridge)

    const first = cmds.emulatorAdbConnect({ address: ADDRESS })
    const second = cmds.emulatorAdbConnect({ address: ADDRESS })
    resolveConnect({ stdout: `connected to ${ADDRESS}`, stderr: '', code: 0 })
    const [firstStatus, secondStatus] = await Promise.all([first, second])

    expect(firstStatus).toEqual(secondStatus)
    const connectCalls = androidCommandRunnerMock.mock.calls.filter(
      (call) => (call[1] as string[])[0] === 'connect'
    )
    expect(connectCalls).toHaveLength(1)
  })
})
