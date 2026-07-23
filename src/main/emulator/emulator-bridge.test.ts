import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmulatorSessionInfo } from './emulator-types'
import type { SimulatorDevice } from './simctl-simulator-devices'
import type { ServeSimHelperProcess } from './serve-sim-helper-processes'

const {
  execServeSimCommandMock,
  hideNativeSimulatorAppMock,
  killServeSimHelperProcessesForDeviceMock,
  listSimulatorDevicesMock,
  listServeSimHelperProcessesForDeviceMock,
  shutdownSimulatorDeviceMock
} = vi.hoisted(() => ({
  execServeSimCommandMock: vi.fn(async () => ({})),
  hideNativeSimulatorAppMock: vi.fn(async () => {}),
  killServeSimHelperProcessesForDeviceMock: vi.fn(async () => {}),
  listSimulatorDevicesMock: vi.fn(async (): Promise<SimulatorDevice[]> => []),
  listServeSimHelperProcessesForDeviceMock: vi.fn(async (): Promise<ServeSimHelperProcess[]> => []),
  shutdownSimulatorDeviceMock: vi.fn(async () => {})
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
  shutdownSimulatorDevice: shutdownSimulatorDeviceMock
}))

vi.mock('./serve-sim-helper-processes', () => ({
  killServeSimHelperProcessesForDevice: killServeSimHelperProcessesForDeviceMock,
  listServeSimHelperProcessesForDevice: listServeSimHelperProcessesForDeviceMock
}))

vi.mock('./simulator-app-visibility', () => ({
  hideNativeSimulatorApp: hideNativeSimulatorAppMock
}))

// Keep the Android backend inert in these iOS-focused tests (no host SDK, no adb I/O).
vi.mock('./android/android-sdk-host-discovery', () => ({
  discoverAndroidSdkFromHost: () => null,
  setConfiguredAndroidSdkPath: () => {}
}))

// These tests exercise the iOS backend, which is gated to macOS.
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
    helperPid: 1234,
    // iOS serve-sim sessions round-trip through the registry as mjpeg.
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
  })

  it('stops the previous Orca-managed helper when a worktree switches devices', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-old'), { managed: true })

    const stoppedUdid = await bridge.stopActiveManagedForWorktree('wt-1')

    expect(stoppedUdid).toBe('device-old')
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      { command: '/serve-sim', env: {} },
      ['--kill', '-q', 'device-old'],
      undefined
    )
    expect(killServeSimHelperProcessesForDeviceMock).toHaveBeenCalledWith('device-old', {
      helperPid: 1234,
      includeOrphaned: false
    })
    expect(bridge.getActiveForWorktree('wt-1')).toBeNull()
  })

  it('shuts down the previous Orca-managed device when requested', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-old'), { managed: true })

    const stoppedUdid = await bridge.stopActiveManagedForWorktree('wt-1', {
      shutdownDevice: true
    })

    expect(stoppedUdid).toBe('device-old')
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      { command: '/serve-sim', env: {} },
      ['--kill', '-q', 'device-old'],
      undefined
    )
    expect(killServeSimHelperProcessesForDeviceMock).toHaveBeenCalledWith('device-old', {
      helperPid: 1234,
      includeOrphaned: false
    })
    expect(shutdownSimulatorDeviceMock).toHaveBeenCalledWith('device-old')
    expect(bridge.getActiveForWorktree('wt-1')).toBeNull()
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

  it('replaces a rediscovered active helper when a worktree explicitly switches devices', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-external'))

    const stoppedUdid = await bridge.stopActiveForWorktree('wt-1', { shutdownDevice: true })

    expect(stoppedUdid).toBe('device-external')
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      { command: '/serve-sim', env: {} },
      ['--kill', '-q', 'device-external'],
      undefined
    )
    expect(killServeSimHelperProcessesForDeviceMock).toHaveBeenCalledWith('device-external', {
      helperPid: 1234,
      includeOrphaned: true
    })
    expect(shutdownSimulatorDeviceMock).toHaveBeenCalledWith('device-external')
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
      ['--kill', '-q', 'device-managed'],
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

  it('rejects a capability the resolved backend does not support', async () => {
    const bridge = new EmulatorBridge()
    // device-1 resolves to the iOS backend, which does not advertise install.
    await expect(
      bridge.runCapability('install', { device: 'device-1' }, async () => 'unused')
    ).rejects.toMatchObject({ code: 'emulator_unsupported' })
  })

  it('routes ax to the active session ax endpoint on iOS', async () => {
    const fetchAccessibilityTree = vi.fn(async () => ({ elements: [] }))
    const bridge = new EmulatorBridge({ fetchAccessibilityTree })
    bridge.registerActiveEmulator('wt-1', {
      ...session('device-1'),
      axUrl: 'http://127.0.0.1:3100/device-1/ax'
    })

    await expect(bridge.accessibilityTree({ worktreeId: 'wt-1' })).resolves.toEqual({
      elements: []
    })
    expect(fetchAccessibilityTree).toHaveBeenCalledWith('http://127.0.0.1:3100/device-1/ax')
  })

  it('derives the ax endpoint for sessions registered without axUrl', async () => {
    const fetchAccessibilityTree = vi.fn(async () => ({ elements: [] }))
    const bridge = new EmulatorBridge({ fetchAccessibilityTree })
    // e.g. renderer-supplied session info that predates ax derivation.
    bridge.registerActiveEmulator('wt-1', {
      ...session('device-1'),
      streamUrl: 'http://127.0.0.1:3100/stream.mjpeg'
    })

    await expect(bridge.accessibilityTree({ worktreeId: 'wt-1' })).resolves.toEqual({
      elements: []
    })
    expect(fetchAccessibilityTree).toHaveBeenCalledWith('http://127.0.0.1:3100/ax')
  })

  it('rejects ax when the session has no ax endpoint and none can be derived', async () => {
    const bridge = new EmulatorBridge()
    // session() streamUrl has no mjpeg suffix, so no /ax endpoint can be inferred.
    bridge.registerActiveEmulator('wt-1', session('device-1'))

    await expect(bridge.accessibilityTree({ worktreeId: 'wt-1' })).rejects.toMatchObject({
      code: 'emulator_no_active'
    })
  })

  it('kills the helper and shuts down the selected simulator', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })

    const shutdownUdid = await bridge.shutdown(undefined, 'wt-1')

    expect(shutdownUdid).toBe('device-1')
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      { command: '/serve-sim', env: {} },
      ['--kill', '-q', 'device-1'],
      undefined
    )
    expect(killServeSimHelperProcessesForDeviceMock).toHaveBeenCalledWith('device-1', {
      helperPid: 1234,
      includeOrphaned: true
    })
    expect(shutdownSimulatorDeviceMock).toHaveBeenCalledWith('device-1')
    expect(bridge.getActiveForWorktree('wt-1')).toBeNull()
  })

  it('reuses the active helper for the same requested device', async () => {
    const waitForEndpointReady = vi.fn(async () => true)
    const bridge = new EmulatorBridge({ waitForEndpointReady })
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })

    const reusable = await bridge.getReusableActiveForWorktree('wt-1', 'device-1')

    expect(reusable?.deviceUdid).toBe('device-1')
    expect(waitForEndpointReady).toHaveBeenCalledWith('http://127.0.0.1:3100/device-1')
    expect(listServeSimHelperProcessesForDeviceMock).toHaveBeenCalledWith('device-1', {
      helperPid: 1234,
      includeOrphaned: true
    })
    expect(execServeSimCommandMock).not.toHaveBeenCalled()
    expect(killServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
    expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
  })

  it('does not reuse the active helper when switching devices', async () => {
    const waitForEndpointReady = vi.fn(async () => true)
    const bridge = new EmulatorBridge({ waitForEndpointReady })
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })

    const reusable = await bridge.getReusableActiveForWorktree('wt-1', 'device-2')

    expect(reusable).toBeNull()
    expect(waitForEndpointReady).not.toHaveBeenCalled()
    expect(listServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
  })

  it('does not reuse an active helper with a stale endpoint', async () => {
    const waitForEndpointReady = vi.fn(async () => false)
    const bridge = new EmulatorBridge({ waitForEndpointReady })
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })

    const reusable = await bridge.getReusableActiveForWorktree('wt-1', 'device-1')

    expect(reusable).toBeNull()
    expect(waitForEndpointReady).toHaveBeenCalledWith('http://127.0.0.1:3100/device-1')
    expect(listServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
  })

  it('retries once when serve-sim returns a stale stream endpoint', async () => {
    const waitForEndpointReady = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    execServeSimCommandMock.mockResolvedValue({
      device: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102'
    })
    const bridge = new EmulatorBridge({ waitForEndpointReady })

    const info = await bridge.startHelperForDevice('device-1')

    expect(info.deviceUdid).toBe('device-1')
    expect(waitForEndpointReady).toHaveBeenCalledTimes(2)
    expect(execServeSimCommandMock).toHaveBeenNthCalledWith(
      1,
      { command: '/serve-sim', env: {} },
      ['--detach', '-q', 'device-1'],
      { json: true }
    )
    expect(execServeSimCommandMock).toHaveBeenNthCalledWith(
      2,
      { command: '/serve-sim', env: {} },
      ['--kill', '-q', 'device-1'],
      undefined
    )
    expect(killServeSimHelperProcessesForDeviceMock).toHaveBeenCalledWith('device-1', {
      helperPid: undefined,
      includeOrphaned: true
    })
    expect(listServeSimHelperProcessesForDeviceMock).toHaveBeenCalledWith('device-1', {
      helperPid: undefined,
      includeOrphaned: true
    })
    expect(execServeSimCommandMock).toHaveBeenNthCalledWith(
      3,
      { command: '/serve-sim', env: {} },
      ['--detach', '-q', 'device-1'],
      { json: true }
    )
    expect(hideNativeSimulatorAppMock).toHaveBeenCalledTimes(1)
  })

  it('rejects detach results whose stream endpoint never becomes reachable', async () => {
    const waitForEndpointReady = vi.fn(async () => false)
    execServeSimCommandMock.mockResolvedValue({
      device: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102'
    })
    const bridge = new EmulatorBridge({ waitForEndpointReady })

    await expect(bridge.startHelperForDevice('device-1')).rejects.toMatchObject({
      code: 'emulator_helper_failed'
    })

    expect(waitForEndpointReady).toHaveBeenCalledTimes(2)
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      { command: '/serve-sim', env: {} },
      ['--kill', '-q', 'device-1'],
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

    await expect(bridge.startHelperForDevice('device-1')).rejects.toMatchObject({
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
  })

  it('reconnects to an existing active helper instead of replacing it', async () => {
    const send = vi.fn()
    const waitForEndpointReady = vi.fn(async () => true)
    const bridge = new EmulatorBridge({ waitForEndpointReady })
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveWorktreeSelector: vi.fn(async () => ({ id: 'wt-1' })),
      getAuthoritativeWindow: () => ({ webContents: { send } }) as never,
      getSettings: () => ({
        mobileEmulatorEnabled: true,
        mobileEmulatorDefaultDeviceUdid: null
      })
    })

    const res = await commands.emulatorAttach({ device: 'device-1', worktree: 'wt-1' })

    expect(res).toEqual({ attached: true, info: session('device-1') })
    expect(execServeSimCommandMock).not.toHaveBeenCalled()
    expect(killServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
    expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('ui:emulatorAutoAttach', {
      worktreeId: 'wt-1',
      info: session('device-1')
    })
  })

  it('routes emulatorAx through the bridge to the active session ax endpoint', async () => {
    const fetchAccessibilityTree = vi.fn(async () => ({ elements: [{ label: 'Login' }] }))
    const bridge = new EmulatorBridge({ fetchAccessibilityTree })
    bridge.registerActiveEmulator('wt-1', {
      ...session('device-1'),
      axUrl: 'http://127.0.0.1:3100/device-1/ax'
    })
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveWorktreeSelector: vi.fn(async () => ({ id: 'wt-1' })),
      getAuthoritativeWindow: () => ({ webContents: { send: vi.fn() } }) as never,
      getSettings: () => ({
        mobileEmulatorEnabled: true,
        mobileEmulatorDefaultDeviceUdid: null
      })
    })

    await expect(commands.emulatorAx({ worktree: 'wt-1' })).resolves.toEqual({
      elements: [{ label: 'Login' }]
    })
    expect(fetchAccessibilityTree).toHaveBeenCalledWith('http://127.0.0.1:3100/device-1/ax')
  })

  it('rejects attach when mobile emulator is disabled', async () => {
    const bridge = new EmulatorBridge()
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveWorktreeSelector: vi.fn(async () => ({ id: 'wt-1' })),
      getAuthoritativeWindow: () => ({ webContents: { send: vi.fn() } }) as never,
      getSettings: () => ({
        mobileEmulatorEnabled: false,
        mobileEmulatorDefaultDeviceUdid: null
      })
    })

    await expect(
      commands.emulatorAttach({ device: 'device-1', worktree: 'wt-1' })
    ).rejects.toMatchObject({ code: 'emulator_disabled' })
    expect(execServeSimCommandMock).not.toHaveBeenCalled()
  })

  it('uses the configured default device when attach omits a device', async () => {
    const waitForEndpointReady = vi.fn(async () => true)
    execServeSimCommandMock.mockResolvedValue({
      device: 'device-default',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102'
    })
    const bridge = new EmulatorBridge({ waitForEndpointReady })
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveWorktreeSelector: vi.fn(async () => ({ id: 'wt-1' })),
      getAuthoritativeWindow: () => ({ webContents: { send: vi.fn() } }) as never,
      getSettings: () => ({
        mobileEmulatorEnabled: true,
        mobileEmulatorDefaultDeviceUdid: 'device-default'
      })
    })

    const res = await commands.emulatorAttach({ worktree: 'wt-1' })

    expect(res.info?.deviceUdid).toBe('device-default')
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      { command: '/serve-sim', env: {} },
      ['--detach', '-q', 'device-default'],
      { json: true }
    )
  })

  it('auto-selects an available iPhone when no device or default is provided', async () => {
    const waitForEndpointReady = vi.fn(async () => true)
    listSimulatorDevicesMock.mockResolvedValue([
      {
        name: 'iPad Pro',
        udid: 'device-ipad',
        state: 'Shutdown',
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0'
      },
      {
        name: 'iPhone 17 Pro',
        udid: 'device-iphone',
        state: 'Shutdown',
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0'
      }
    ])
    execServeSimCommandMock.mockResolvedValue({
      device: 'device-iphone',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102'
    })
    const bridge = new EmulatorBridge({ waitForEndpointReady })
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveWorktreeSelector: vi.fn(async () => ({ id: 'wt-1' })),
      getAuthoritativeWindow: () => ({ webContents: { send: vi.fn() } }) as never,
      getSettings: () => ({
        mobileEmulatorEnabled: true,
        mobileEmulatorDefaultDeviceUdid: null
      })
    })

    const res = await commands.emulatorAttach({ worktree: 'wt-1' })

    expect(res.info?.deviceUdid).toBe('device-iphone')
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      { command: '/serve-sim', env: {} },
      ['--detach', '-q', 'device-iphone'],
      { json: true }
    )
  })
})
