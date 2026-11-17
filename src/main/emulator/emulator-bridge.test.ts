import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmulatorSessionInfo } from './emulator-types'
import type { SimulatorDevice } from './simctl-simulator-devices'
import type { ServeSimHelperProcess } from './serve-sim-helper-processes'
import type * as ServeSimExecution from './serve-sim-execution'

const {
  execServeSimCommandMock,
  hideNativeSimulatorAppMock,
  killServeSimHelperProcessesForDeviceMock,
  listSimulatorDevicesMock,
  listServeSimHelperProcessesForDeviceMock,
  shutdownSimulatorDeviceMock,
  netFetchMock,
  assertInputNotShadowedMock
} = vi.hoisted(() => ({
  assertInputNotShadowedMock: vi.fn(async (_udid: string) => {}),
  execServeSimCommandMock: vi.fn(async () => ({})),
  hideNativeSimulatorAppMock: vi.fn(async () => {}),
  killServeSimHelperProcessesForDeviceMock: vi.fn(async () => {}),
  listSimulatorDevicesMock: vi.fn(async (): Promise<SimulatorDevice[]> => []),
  listServeSimHelperProcessesForDeviceMock: vi.fn(async (): Promise<ServeSimHelperProcess[]> => []),
  shutdownSimulatorDeviceMock: vi.fn(async () => {}),
  netFetchMock: vi.fn()
}))

vi.mock('../network/http-client', () => ({ getMainHttpClient: () => ({ fetch: netFetchMock }) }))

vi.mock('./serve-sim-execution', async (importOriginal) => ({
  execServeSimCommand: execServeSimCommandMock,
  parseServeSimCommandArgs: vi.fn(() => []),
  resolveServeSimExecutable: vi.fn(() => ({ command: '/serve-sim', env: {} })),
  serveSimKillArgs: (await importOriginal<typeof ServeSimExecution>()).serveSimKillArgs,
  stripEmulatorTargetArgs: vi.fn((args: string[]) => args)
}))

vi.mock('./simctl-simulator-devices', () => ({
  ensureSimulatorBooted: vi.fn(async () => {}),
  listSimulatorDevices: listSimulatorDevicesMock,
  resolveSimulatorUdid: vi.fn(async (device: string) => device),
  shutdownSimulatorDevice: shutdownSimulatorDeviceMock
}))

vi.mock('./serve-sim-helper-processes', () => ({
  killServeSimHelperProcessesForDevice: killServeSimHelperProcessesForDeviceMock,
  listServeSimHelperProcessesForDevice: listServeSimHelperProcessesForDeviceMock
}))

vi.mock('./simulator-device-hub-input', () => ({
  assertSimulatorInputNotShadowedByDeviceHub: assertInputNotShadowedMock
}))

vi.mock('./simulator-app-visibility', () => ({
  hideNativeSimulatorApp: hideNativeSimulatorAppMock
}))

// Keep the Android backend inert in these iOS-focused tests (no host SDK, no adb I/O).
vi.mock('./android/android-sdk-host-discovery', () => ({
  discoverAndroidSdkFromHost: () => null,
  setConfiguredAndroidSdkPath: () => {}
}))

vi.mock('os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, platform: () => 'darwin' }
})
import { EmulatorBridge } from './emulator-bridge'
import { IosEmulatorBackend } from './backends/ios-emulator-backend'
import { RuntimeEmulatorCommands } from '../runtime/emulator/runtime-emulator-commands'

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

describe('EmulatorBridge helper ownership', () => {
  beforeEach(() => {
    execServeSimCommandMock.mockReset()
    execServeSimCommandMock.mockImplementation(async () => ({}))
    listSimulatorDevicesMock.mockReset()
    listSimulatorDevicesMock.mockImplementation(async () => [])
    killServeSimHelperProcessesForDeviceMock.mockReset()
    killServeSimHelperProcessesForDeviceMock.mockImplementation(async () => {})
    listServeSimHelperProcessesForDeviceMock.mockReset()
    listServeSimHelperProcessesForDeviceMock.mockImplementation(async () => [
      { pid: 1234, command: 'serve-sim-bin device-1' }
    ])
    hideNativeSimulatorAppMock.mockReset()
    hideNativeSimulatorAppMock.mockImplementation(async () => {})
    shutdownSimulatorDeviceMock.mockReset()
    shutdownSimulatorDeviceMock.mockImplementation(async () => {})
    netFetchMock.mockReset()
  })

  it('detaches but does not kill a terminal-started helper', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-external'))

    const stoppedUdid = await bridge.stopActiveManagedForWorktree('wt-1')

    expect(stoppedUdid).toBeNull()
    expect(execServeSimCommandMock).not.toHaveBeenCalled()
    expect(killServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
    expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
    expect(bridge.getActiveForWorktree('wt-1')).toBeNull()
  })

  it('keeps a shared device alive when one registered workspace detaches', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
    bridge.registerActiveEmulator('wt-2', session('device-1'), { managed: true })

    await bridge.shutdown(undefined, 'wt-1')

    expect(killServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
    expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
    expect(bridge.getActiveForWorktree('wt-1')).toBeNull()
    expect(bridge.getActiveForWorktree('wt-2')).toMatchObject({ deviceUdid: 'device-1' })
  })
})

describe('RuntimeEmulatorCommands attach lifecycle', () => {
  beforeEach(() => {
    execServeSimCommandMock.mockReset()
    execServeSimCommandMock.mockImplementation(async () => ({}))
    killServeSimHelperProcessesForDeviceMock.mockReset()
    killServeSimHelperProcessesForDeviceMock.mockImplementation(async () => {})
    listServeSimHelperProcessesForDeviceMock.mockReset()
    listServeSimHelperProcessesForDeviceMock.mockImplementation(async () => [
      { pid: 1234, command: 'serve-sim-bin device-1' }
    ])
    hideNativeSimulatorAppMock.mockReset()
    hideNativeSimulatorAppMock.mockImplementation(async () => {})
    shutdownSimulatorDeviceMock.mockReset()
    shutdownSimulatorDeviceMock.mockImplementation(async () => {})
    netFetchMock.mockReset()
  })

  it('reports when the requested iOS device differs from the active session', async () => {
    listSimulatorDevicesMock.mockResolvedValue([
      {
        name: 'iPhone requested',
        udid: 'device-requested',
        state: 'Booted',
        runtime: 'iOS 26.0'
      }
    ])
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-active'), { managed: true })
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveEmulatorWorkspaceId: vi.fn(async () => 'wt-1'),
      resolveEmulatorCleanupWorkspaceId: vi.fn(async () => 'wt-1'),
      getAuthoritativeWindow: () => ({ webContents: { send: vi.fn() } }) as never,
      getSettings: () => ({
        mobileEmulatorEnabled: true,
        mobileEmulatorDefaultDeviceUdid: null
      })
    })

    await expect(
      commands.emulatorAx({ device: 'device-requested', worktree: 'wt-1' })
    ).rejects.toMatchObject({
      code: 'emulator_no_active',
      message: expect.stringContaining('active: device-active')
    })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('keeps the live workspace device when reopened without a device', async () => {
    listSimulatorDevicesMock.mockImplementation(async () => [
      {
        udid: 'iphone-1',
        name: 'iPhone 16',
        state: 'Shutdown',
        runtime: 'iOS 18.0',
        isAvailable: true
      }
    ])
    vi.spyOn(IosEmulatorBackend.prototype, 'isSessionReusable').mockResolvedValueOnce(true)
    const bridge = new EmulatorBridge({ waitForEndpointReady: vi.fn(async () => true) })
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveEmulatorWorkspaceId: vi.fn(async () => 'wt-1'),
      resolveEmulatorCleanupWorkspaceId: vi.fn(async () => 'wt-1'),
      getAuthoritativeWindow: () => ({ webContents: { send: vi.fn() } }) as never,
      getSettings: () => ({
        mobileEmulatorEnabled: true,
        mobileEmulatorDefaultDeviceUdid: 'iphone-1'
      })
    })

    await expect(commands.emulatorAttach({ worktree: 'wt-1' })).resolves.toEqual({
      attached: true,
      info: { ...session('device-1'), backend: 'ios' }
    })
    expect(execServeSimCommandMock).not.toHaveBeenCalled()
    expect(bridge.getActiveForWorktree('wt-1')?.deviceUdid).toBe('device-1')
  })
})
