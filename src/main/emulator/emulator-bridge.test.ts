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

  it('only kills Orca-managed helpers during app shutdown cleanup', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-managed', session('device-managed'), { managed: true })
    bridge.registerActiveEmulator('wt-external', session('device-external'))

    await bridge.destroyAllSessions()

    expect(execServeSimCommandMock).toHaveBeenCalledTimes(1)
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      { command: '/serve-sim', env: {} },
      ['--kill=device-managed', '-q'],
      undefined
    )
    expect(killServeSimHelperProcessesForDeviceMock).toHaveBeenCalledTimes(1)
    expect(killServeSimHelperProcessesForDeviceMock).toHaveBeenCalledWith('device-managed', {
      helperPid: 1234
    })
    expect(shutdownSimulatorDeviceMock).toHaveBeenCalledWith('device-managed')
    expect(bridge.getActiveForWorktree('wt-managed')).toBeNull()
    expect(bridge.getActiveForWorktree('wt-external')).toBeNull()
  })

  it('does not clean up a failed attach while another start claim can register the device', async () => {
    const waitForEndpointReady = vi.fn(async () => true)
    execServeSimCommandMock.mockResolvedValue({
      device: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102'
    })
    const bridge = new EmulatorBridge({ waitForEndpointReady })

    const failedLease = await bridge.acquireHelperForDevice('device-1')
    const survivingLease = await bridge.acquireHelperForDevice('device-1')

    await failedLease.release({ cleanupIfUnused: true })
    bridge.registerActiveEmulator('wt-surviving', survivingLease.info, { managed: true })
    await survivingLease.release()

    expect(killServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
    expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
    expect(bridge.getActiveForWorktree('wt-surviving')).toMatchObject({
      deviceUdid: 'device-1'
    })
  })

  it('keeps a shared device alive when one registered workspace detaches', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
    bridge.registerActiveEmulator('wt-2', session('device-1'), { managed: true })

    await bridge.stopActiveManagedForWorktree('wt-1', { shutdownDevice: true })

    expect(killServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
    expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
    expect(bridge.getActiveForWorktree('wt-1')).toBeNull()
    expect(bridge.getActiveForWorktree('wt-2')).toMatchObject({ deviceUdid: 'device-1' })
  })

  it('keeps a device alive when its last registered workspace closes during another attach', async () => {
    let finishStart:
      | ((info: Awaited<ReturnType<typeof execServeSimCommandMock>>) => void)
      | undefined
    execServeSimCommandMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = resolve
        })
    )
    const bridge = new EmulatorBridge({ waitForEndpointReady: vi.fn(async () => true) })
    bridge.registerActiveEmulator('wt-closing', session('device-1'), { managed: true })

    const leasePromise = bridge.acquireHelperForDevice('device-1')
    await vi.waitFor(() => expect(execServeSimCommandMock).toHaveBeenCalledOnce())
    const shutdown = bridge.shutdownActiveManagedForWorktree('wt-closing')
    await Promise.resolve()

    expect(killServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
    finishStart?.({
      device: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102'
    })
    const lease = await leasePromise
    bridge.registerActiveEmulator('wt-attaching', lease.info, { managed: true })
    await lease.release()
    await shutdown

    expect(killServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
    expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
    expect(bridge.getActiveForWorktree('wt-attaching')).toMatchObject({ deviceUdid: 'device-1' })
  })

  it('rejects detach results whose stream endpoint never becomes reachable', async () => {
    const waitForEndpointReady = vi.fn(async () => false)
    execServeSimCommandMock.mockResolvedValue({
      device: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102'
    })
    const bridge = new EmulatorBridge({ waitForEndpointReady })

    await expect(bridge.acquireHelperForDevice('device-1')).rejects.toMatchObject({
      code: 'emulator_helper_failed'
    })

    expect(waitForEndpointReady).toHaveBeenCalledTimes(2)
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      { command: '/serve-sim', env: {} },
      ['--kill=device-1', '-q'],
      undefined
    )
    expect(killServeSimHelperProcessesForDeviceMock).toHaveBeenCalledTimes(2)
    expect(listServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
    expect(hideNativeSimulatorAppMock).not.toHaveBeenCalled()
  })

  it('rejects stale reachable endpoints when no exact serve-sim helper is alive', async () => {
    const waitForEndpointReady = vi.fn(async () => true)
    listServeSimHelperProcessesForDeviceMock.mockResolvedValue([])
    execServeSimCommandMock.mockResolvedValue({
      device: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102'
    })
    const bridge = new EmulatorBridge({ waitForEndpointReady })

    await expect(bridge.acquireHelperForDevice('device-1')).rejects.toMatchObject({
      code: 'emulator_helper_failed'
    })

    expect(waitForEndpointReady).toHaveBeenCalledTimes(2)
    expect(listServeSimHelperProcessesForDeviceMock).toHaveBeenCalledTimes(2)
    expect(killServeSimHelperProcessesForDeviceMock).toHaveBeenCalledTimes(2)
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
