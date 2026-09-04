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
  shutdownSimulatorDeviceMock,
  netFetchMock,
  discoverAndroidSdkFromHostMock,
  androidCommandRunnerMock
} = vi.hoisted(() => ({
  execServeSimCommandMock: vi.fn(async () => ({})),
  hideNativeSimulatorAppMock: vi.fn(async () => {}),
  killServeSimHelperProcessesForDeviceMock: vi.fn(async () => {}),
  listSimulatorDevicesMock: vi.fn(async (): Promise<SimulatorDevice[]> => []),
  listServeSimHelperProcessesForDeviceMock: vi.fn(async (): Promise<ServeSimHelperProcess[]> => []),
  shutdownSimulatorDeviceMock: vi.fn(async () => {}),
  netFetchMock: vi.fn(),
  // Default null: the iOS-focused tests below keep the android backend inert.
  // A dedicated test overrides this to a real SDK to prove the emu-kill guard.
  discoverAndroidSdkFromHostMock: vi.fn((): unknown => null),
  androidCommandRunnerMock: vi.fn(async (_binary: string, _args: readonly string[]) => ({
    stdout: '',
    stderr: '',
    code: 0
  }))
}))

// app.getPath: scrcpy-server-download (android backend transitive import).
// net.fetch: iOS accessibility tree tests.
vi.mock('electron', () => ({
  app: { getPath: () => '/mock-userdata' },
  net: { fetch: netFetchMock }
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

// Keep the Android backend inert in these iOS-focused tests (no host SDK, no adb I/O)
// by default; one test overrides discoverAndroidSdkFromHostMock to exercise the
// android backend's emu-kill guard end-to-end through the bridge.
vi.mock('./android/android-sdk-host-discovery', () => ({
  discoverAndroidSdkFromHost: discoverAndroidSdkFromHostMock,
  setConfiguredAndroidSdkPath: () => {}
}))

// EmulatorBridge always constructs a real AndroidEmulatorBackend with the default
// (execFile-based) command runner; swap it for a recording mock so the emu-kill
// guard test can assert on the exact adb invocations without spawning a process.
vi.mock('./android/android-command-runner', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, execFileAndroidCommandRunner: androidCommandRunnerMock }
})

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
    axUrl: `http://127.0.0.1:3100/${deviceUdid}/ax`,
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
    netFetchMock.mockReset()
    discoverAndroidSdkFromHostMock.mockReset()
    discoverAndroidSdkFromHostMock.mockReturnValue(null)
    androidCommandRunnerMock.mockReset()
    androidCommandRunnerMock.mockImplementation(async () => ({ stdout: '', stderr: '', code: 0 }))
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

  it('never sends emu kill to a TCP or USB android device during destroyAllSessions/app-quit', async () => {
    discoverAndroidSdkFromHostMock.mockReturnValue({
      sdkRoot: '/sdk',
      adb: '/sdk/adb',
      avdTools: null
    })
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

    // Re-register and drive the same guard through the app-quit path, which is
    // the hard rule's other named entry point (onAppQuit just calls destroyAllSessions).
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
    discoverAndroidSdkFromHostMock.mockReturnValue({
      sdkRoot: '/sdk',
      adb: '/sdk/adb',
      avdTools: null
    })
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
    // The orphan-forward cleanup (part of stopHelperForDevice) must be issued
    // strictly before `adb disconnect` — tearing down the stream before the
    // connection it rides on.
    const argLists = androidCommandRunnerMock.mock.calls.map((call) => call[1] as string[])
    const forwardIndex = argLists.findIndex((args) => args.includes('forward'))
    const disconnectIndex = argLists.findIndex((args) => args[0] === 'disconnect')
    expect(forwardIndex).toBeGreaterThanOrEqual(0)
    expect(disconnectIndex).toBeGreaterThan(forwardIndex)
  })

  it('never issues adb disconnect on pane-close (stopActiveForWorktree) or app quit', async () => {
    const ADDRESS = '127.0.0.1:5555'
    discoverAndroidSdkFromHostMock.mockReturnValue({
      sdkRoot: '/sdk',
      adb: '/sdk/adb',
      avdTools: null
    })
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

  it('rejects a capability the resolved backend does not support', async () => {
    const bridge = new EmulatorBridge()
    // device-1 resolves to the iOS backend, which advertises no explicit-verb caps.
    await expect(
      bridge.runCapability('install', { device: 'device-1' }, async () => 'unused')
    ).rejects.toMatchObject({ code: 'emulator_unsupported' })
  })

  it('routes an offline ADB network address to the android backend, not the darwin/iOS fallback', async () => {
    const bridge = new EmulatorBridge()
    // iOS has no `install` capability, so if this routed to iOS (the pre-fix
    // fallback on darwin) it would reject with emulator_unsupported instead.
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
    // 'unknown-device' is not host:port shaped, so it still falls through to the
    // darwin-primary backend (iOS), matching pre-existing fallback behavior.
    await expect(
      bridge.runCapability('install', { device: 'unknown-device' }, async () => 'unused')
    ).rejects.toMatchObject({ code: 'emulator_unsupported' })
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

  it('cleans up a failed attach when no start claim or registered workspace remains', async () => {
    const waitForEndpointReady = vi.fn(async () => true)
    execServeSimCommandMock.mockResolvedValue({
      device: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102'
    })
    const bridge = new EmulatorBridge({ waitForEndpointReady })

    const lease = await bridge.acquireHelperForDevice('device-1')
    await lease.release({ cleanupIfUnused: true })

    expect(killServeSimHelperProcessesForDeviceMock).toHaveBeenCalledWith('device-1', {
      helperPid: undefined,
      includeOrphaned: true
    })
    expect(shutdownSimulatorDeviceMock).toHaveBeenCalledWith('device-1')
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

    const { info } = await bridge.acquireHelperForDevice('device-1')

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

    await expect(bridge.acquireHelperForDevice('device-1')).rejects.toMatchObject({
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
    discoverAndroidSdkFromHostMock.mockReset()
    discoverAndroidSdkFromHostMock.mockReturnValue(null)
    androidCommandRunnerMock.mockReset()
    androidCommandRunnerMock.mockImplementation(async () => ({ stdout: '', stderr: '', code: 0 }))
  })

  it('reads iOS accessibility from the active worktree session', async () => {
    const tree = [{ type: 'Application', children: [] }]
    netFetchMock.mockResolvedValue(new Response(JSON.stringify(tree), { status: 200 }))
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
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

    // Routing test: normalization is covered in serve-sim-ax-normalization.test.ts.
    await expect(commands.emulatorAx({ worktree: 'wt-1' })).resolves.toMatchObject([
      { type: 'Application' }
    ])
    expect(netFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3100/device-1/ax',
      expect.any(Object)
    )
  })

  it('reads iOS accessibility from an attached device without a worktree', async () => {
    const tree = [{ type: 'Application', children: [] }]
    netFetchMock.mockResolvedValue(new Response(JSON.stringify(tree), { status: 200 }))
    listSimulatorDevicesMock.mockResolvedValue([
      {
        name: 'iPhone attached',
        udid: 'device-1',
        state: 'Booted',
        runtime: 'iOS 26.0'
      }
    ])
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
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

    await expect(commands.emulatorAx({ device: 'device-1' })).resolves.toMatchObject([
      { type: 'Application' }
    ])
    expect(netFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3100/device-1/ax',
      expect.any(Object)
    )
  })

  it('reads ax for an explicit device when the worktree has no active session', async () => {
    const tree = [{ type: 'Application', children: [] }]
    netFetchMock.mockResolvedValue(new Response(JSON.stringify(tree), { status: 200 }))
    listSimulatorDevicesMock.mockResolvedValue([
      {
        name: 'iPhone elsewhere',
        udid: 'device-1',
        state: 'Booted',
        runtime: 'iOS 26.0'
      }
    ])
    const bridge = new EmulatorBridge()
    // The session lives under another worktree; the CLI still resolves the
    // caller's cwd worktree, which has nothing attached.
    bridge.registerActiveEmulator('wt-other', session('device-1'), { managed: true })
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
      commands.emulatorAx({ device: 'device-1', worktree: 'wt-1' })
    ).resolves.toMatchObject([{ type: 'Application' }])
    expect(netFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3100/device-1/ax',
      expect.any(Object)
    )
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

  it('heals a session registered without an axUrl by deriving it from the stream url', async () => {
    const tree = [{ type: 'Application', children: [] }]
    netFetchMock.mockResolvedValue(new Response(JSON.stringify(tree), { status: 200 }))
    const bridge = new EmulatorBridge()
    // No axUrl on the registered session (e.g. reattach path predating derivation).
    bridge.registerActiveEmulator(
      'wt-1',
      {
        deviceUdid: 'device-1',
        streamUrl: 'http://127.0.0.1:3100/helper/device-1/stream.mjpeg',
        wsUrl: 'ws://127.0.0.1:3100/helper/device-1/ws',
        streamCodec: 'mjpeg'
      },
      { managed: true }
    )
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

    await expect(commands.emulatorAx({ worktree: 'wt-1' })).resolves.toMatchObject([
      { type: 'Application' }
    ])
    expect(netFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3100/helper/device-1/ax',
      expect.any(Object)
    )
  })

  it('does not fabricate an /ax endpoint from a non-mjpeg stream url', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator(
      'wt-1',
      {
        deviceUdid: 'device-1',
        streamUrl: 'http://127.0.0.1:3100/helper/device-1/stream.h264',
        wsUrl: 'ws://127.0.0.1:3100/helper/device-1/ws',
        streamCodec: 'mjpeg'
      },
      { managed: true }
    )
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

    await expect(commands.emulatorAx({ worktree: 'wt-1' })).rejects.toMatchObject({
      code: 'emulator_no_active'
    })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('reconnects to an existing active helper instead of replacing it', async () => {
    const send = vi.fn()
    const waitForEndpointReady = vi.fn(async () => true)
    const bridge = new EmulatorBridge({ waitForEndpointReady })
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveEmulatorWorkspaceId: vi.fn(async () => 'wt-1'),
      resolveEmulatorCleanupWorkspaceId: vi.fn(async () => 'wt-1'),
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

  it('rejects attach when mobile emulator is disabled', async () => {
    const bridge = new EmulatorBridge()
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveEmulatorWorkspaceId: vi.fn(async () => 'wt-1'),
      resolveEmulatorCleanupWorkspaceId: vi.fn(async () => 'wt-1'),
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
      resolveEmulatorWorkspaceId: vi.fn(async () => 'wt-1'),
      resolveEmulatorCleanupWorkspaceId: vi.fn(async () => 'wt-1'),
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
      resolveEmulatorWorkspaceId: vi.fn(async () => 'wt-1'),
      resolveEmulatorCleanupWorkspaceId: vi.fn(async () => 'wt-1'),
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

describe('RuntimeEmulatorCommands ADB device connection', () => {
  const ADDRESS = '192.168.1.50:5555'

  beforeEach(() => {
    discoverAndroidSdkFromHostMock.mockReset()
    discoverAndroidSdkFromHostMock.mockReturnValue({
      sdkRoot: '/sdk',
      adb: '/sdk/adb',
      avdTools: null
    })
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
