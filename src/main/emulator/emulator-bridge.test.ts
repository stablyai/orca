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
import { ServeSimOwnedSessions } from './serve-sim-owned-session'
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

  it('checks the shutdown deadline after an owned iOS helper has exited', async () => {
    const backend = new IosEmulatorBackend()
    let finish!: () => void
    const stop = vi
      .spyOn(ServeSimOwnedSessions.prototype, 'stop')
      .mockImplementationOnce(async (_device, _pid, shutdown) => {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        await shutdown?.()
      })
    let expired = false
    try {
      const stopping = backend.stopHelperForDevice('device-1', {
        helperPid: 1234,
        shutdownDevice: true,
        assertShutdownAllowed: () => {
          if (expired) {
            throw new Error('deadline expired')
          }
        }
      })
      await vi.waitFor(() => expect(finish).toBeDefined())
      expired = true
      finish()
      await expect(stopping).rejects.toThrow('deadline expired')
      expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
    } finally {
      stop.mockRestore()
    }
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

  it('closes admission and drains an unfinished start before stopping owned helpers', async () => {
    const bridge = new EmulatorBridge()
    const ios = bridge.listBackends().find((backend) => backend.kind === 'ios')!
    vi.spyOn(ios, 'ownsDevice').mockResolvedValue(true)
    let finish!: (info: EmulatorSessionInfo) => void
    vi.spyOn(ios, 'startSession').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const cleanup = vi.spyOn(ios, 'stopOwnedHelpers').mockResolvedValue()
    const starting = bridge.acquireHelperForDevice('device-1')
    const result = starting.then(
      () => 'started',
      (error: Error) => error.message
    )
    await vi.waitFor(() => expect(finish).toBeDefined())
    const destroying = bridge.destroyAllSessions()
    await expect(bridge.acquireHelperForDevice('device-2')).rejects.toThrow('shutdown')
    finish(session('device-1'))
    expect(await result).toContain('shutdown')
    await destroying
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('reports incomplete shutdown if a lease drains after the deadline', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
    const ios = bridge.listBackends().find((backend) => backend.kind === 'ios')!
    vi.spyOn(ios, 'ownsDevice').mockResolvedValue(true)
    let finish!: (info: EmulatorSessionInfo) => void
    vi.spyOn(ios, 'startSession').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    vi.spyOn(ios, 'stopOwnedHelpers').mockResolvedValue()
    const stop = vi
      .spyOn(ios, 'stopHelperForDevice')
      .mockImplementation(async (_device, options) => {
        options?.assertShutdownAllowed?.()
      })
    const starting = bridge.acquireHelperForDevice('device-1').catch(() => undefined)
    await vi.waitFor(() => expect(finish).toBeDefined())
    const closing = bridge.destroyAllSessions({ deadline: performance.now() - 1 })
    const result = closing.then(
      () => 'stopped',
      (error: Error) => error.message
    )
    finish(session('device-1'))
    await starting
    expect(await result).toContain('deadline expired')
    expect(stop).toHaveBeenCalledOnce()
  })

  it('stops a workspace association without an asynchronous device lookup', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator(
      'wt-1',
      { ...session('emulator-5554'), backend: 'android', instanceId: 'stream-a' },
      { managed: true }
    )
    const android = bridge.listBackends().find((backend) => backend.kind === 'android')!
    const resolve = vi.spyOn(android, 'resolveDeviceId')
    const stop = vi.spyOn(android, 'stopHelperForDevice').mockResolvedValue()
    await expect(bridge.kill(undefined, 'wt-1')).resolves.toBe('emulator-5554')
    expect(resolve).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledWith(
      'emulator-5554',
      expect.objectContaining({ instanceId: 'stream-a' })
    )
  })

  it('uses the backend-owned Android generation for an unscoped explicit stop', async () => {
    const bridge = new EmulatorBridge()
    const android = bridge.listBackends().find((backend) => backend.kind === 'android')!
    vi.spyOn(android, 'ownsDevice').mockResolvedValue(true)
    vi.spyOn(android, 'resolveDeviceId').mockResolvedValue('emulator-5554')
    vi.spyOn(android, 'ownedSessionInfo').mockReturnValue({
      deviceUdid: 'emulator-5554',
      streamUrl: 'scrcpy://emulator-5554',
      wsUrl: '',
      backend: 'android',
      instanceId: 'owned-stream'
    })
    const stop = vi.spyOn(android, 'stopHelperForDevice').mockResolvedValue()
    await bridge.kill('emulator-5554')
    expect(stop).toHaveBeenCalledWith(
      'emulator-5554',
      expect.objectContaining({ instanceId: 'owned-stream', requireInstanceId: true })
    )
  })

  it('rejects reuse when a delayed readiness probe observes a replaced workspace', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
    const ios = bridge.listBackends().find((backend) => backend.kind === 'ios')!
    let finish!: (value: boolean) => void
    vi.spyOn(ios, 'isSessionReusable').mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
    )
    const reuse = bridge.getReusableActiveForWorktree('wt-1')
    await vi.waitFor(() => expect(finish).toBeDefined())
    bridge.registerActiveEmulator('wt-1', session('device-2'), { managed: true })
    finish(true)
    await expect(reuse).rejects.toMatchObject({ code: 'emulator_attach_superseded' })
  })

  it('does not detach a newer selection when the previous session probe finishes late', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
    const ios = bridge.listBackends().find((backend) => backend.kind === 'ios')!
    let finish!: (value: boolean) => void
    vi.spyOn(ios, 'isSessionReusable').mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
    )
    const stop = vi.spyOn(ios, 'stopHelperForDevice').mockResolvedValue()
    const switching = bridge.stopActiveForSwitch('wt-1')
    await vi.waitFor(() => expect(finish).toBeDefined())
    bridge.registerActiveEmulator('wt-1', session('device-2'), { managed: true })
    finish(true)
    await expect(switching).rejects.toMatchObject({ code: 'emulator_attach_superseded' })
    expect(bridge.getActiveForWorktree('wt-1')?.deviceUdid).toBe('device-2')
    expect(stop).not.toHaveBeenCalled()
  })

  it('checks the selection ticket after the probe before unregistering', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
    const ios = bridge.listBackends().find((backend) => backend.kind === 'ios')!
    vi.spyOn(ios, 'isSessionReusable').mockResolvedValueOnce(true)
    await expect(
      bridge.stopActiveForSwitch('wt-1', () => {
        throw new Error('superseded')
      })
    ).rejects.toThrow('superseded')
    expect(bridge.getActiveForWorktree('wt-1')?.deviceUdid).toBe('device-1')
  })

  it('detaches a dead helper without shutting down a simulator another runtime may own', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
    const ios = bridge.listBackends().find((backend) => backend.kind === 'ios')!
    vi.spyOn(ios, 'isSessionReusable').mockResolvedValueOnce(false)
    const stop = vi.spyOn(ios, 'stopHelperForDevice').mockResolvedValueOnce()
    await bridge.stopActiveForSwitch('wt-1')
    expect(stop).toHaveBeenCalledWith(
      'device-1',
      expect.objectContaining({ shutdownDevice: false })
    )
    expect(bridge.getActiveForWorktree('wt-1')).toBeNull()
  })

  it('keeps the workspace association when stopping its owned helper fails', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
    const ios = bridge.listBackends().find((backend) => backend.kind === 'ios')!
    const stop = vi
      .spyOn(ios, 'stopHelperForDevice')
      .mockRejectedValueOnce(new Error('ownership lost'))
    await expect(bridge.shutdown(undefined, 'wt-1')).rejects.toThrow('ownership lost')
    expect(bridge.getActiveForWorktree('wt-1')?.deviceUdid).toBe('device-1')
    stop.mockRestore()
  })

  it('does not restore a stale association over a newer selection', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
    const ios = bridge.listBackends().find((backend) => backend.kind === 'ios')!
    let fail!: (error: Error) => void
    vi.spyOn(ios, 'stopHelperForDevice').mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject
        })
    )
    const stopping = bridge.shutdown(undefined, 'wt-1')
    await vi.waitFor(() => expect(fail).toBeDefined())
    bridge.registerActiveEmulator('wt-1', session('device-2'), { managed: true })
    fail(new Error('ownership lost'))
    await expect(stopping).rejects.toThrow('ownership lost')
    expect(bridge.getActiveForWorktree('wt-1')?.deviceUdid).toBe('device-2')
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

  it('does not report unscoped attachment after the helper was stopped during lease release', async () => {
    const bridge = new EmulatorBridge()
    const info = session('device-1')
    vi.spyOn(bridge, 'acquireHelperForDevice').mockResolvedValue({ info, release: async () => {} })
    vi.spyOn(bridge, 'isOwnedSessionReusable').mockResolvedValue(false)
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveEmulatorWorkspaceId: vi.fn(),
      resolveEmulatorCleanupWorkspaceId: vi.fn(),
      getAuthoritativeWindow: () => ({ webContents: { send: vi.fn() } }) as never,
      getSettings: () => ({ mobileEmulatorEnabled: true })
    })
    await expect(commands.emulatorAttach({ device: 'device-1' })).rejects.toMatchObject({
      code: 'emulator_attach_superseded'
    })
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

  it('notifies every shared workspace when a dead helper is replaced', async () => {
    const bridge = new EmulatorBridge()
    const old = session('device-1')
    const replacement = {
      ...old,
      helperPid: 4321,
      streamUrl: 'http://127.0.0.1:3200/new',
      wsUrl: 'ws://127.0.0.1:3200/new'
    }
    bridge.registerActiveEmulator('wt-1', old, { managed: true })
    bridge.registerActiveEmulator('wt-2', old, { managed: true })
    const ios = bridge.listBackends().find((backend) => backend.kind === 'ios')!
    vi.spyOn(ios, 'isSessionReusable').mockResolvedValue(false)
    vi.spyOn(ios, 'startSession').mockResolvedValue(replacement)
    const send = vi.fn()
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveEmulatorWorkspaceId: vi.fn(async () => 'wt-1'),
      resolveEmulatorCleanupWorkspaceId: vi.fn(async () => 'wt-1'),
      getAuthoritativeWindow: () => ({ webContents: { send } }) as never,
      getSettings: () => ({ mobileEmulatorEnabled: true })
    })
    await commands.emulatorAttach({ worktree: 'wt-1', device: 'device-1', focus: true })
    expect(send).toHaveBeenCalledWith('ui:emulatorAutoAttach', {
      worktreeId: 'wt-2',
      info: replacement
    })
    expect(send).toHaveBeenCalledWith('ui:emulatorAutoAttach', {
      worktreeId: 'wt-1',
      info: replacement
    })
    expect(send).toHaveBeenCalledWith('emulator:pane-focus', { worktreeId: 'wt-1' })
    expect(send).not.toHaveBeenCalledWith('emulator:pane-focus', { worktreeId: 'wt-2' })
  })

  it('does not notify a shared workspace that detached before publication', async () => {
    const bridge = new EmulatorBridge()
    const old = session('device-1')
    const replacement = {
      ...old,
      helperPid: 4321,
      streamUrl: 'http://127.0.0.1:3200/new',
      wsUrl: 'ws://127.0.0.1:3200/new'
    }
    bridge.registerActiveEmulator('wt-1', old, { managed: true })
    bridge.registerActiveEmulator('wt-2', old, { managed: true })
    const register = bridge.registerActiveEmulator.bind(bridge)
    vi.spyOn(bridge, 'registerActiveEmulator').mockImplementation((...args) => {
      const affected = register(...args)
      bridge.unregisterActiveEmulator('wt-2')
      return affected
    })
    vi.spyOn(bridge, 'getReusableActiveForWorktree').mockResolvedValue(null)
    vi.spyOn(bridge, 'stopActiveForSwitch').mockResolvedValue(null)
    vi.spyOn(bridge, 'acquireHelperForDevice').mockResolvedValue({
      info: replacement,
      release: async () => {}
    })
    const send = vi.fn()
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveEmulatorWorkspaceId: vi.fn(async () => 'wt-1'),
      resolveEmulatorCleanupWorkspaceId: vi.fn(async () => 'wt-1'),
      getAuthoritativeWindow: () => ({ webContents: { send } }) as never,
      getSettings: () => ({ mobileEmulatorEnabled: true })
    })
    await commands.emulatorAttach({ worktree: 'wt-1', device: 'device-1' })
    expect(send).not.toHaveBeenCalledWith('ui:emulatorAutoAttach', {
      worktreeId: 'wt-2',
      info: replacement
    })
  })

  it('publishes the shared replacement before a superseded requester releases its lease', async () => {
    listSimulatorDevicesMock.mockResolvedValue([
      { name: 'iPhone', udid: 'device-1', state: 'Booted', runtime: 'iOS' }
    ])
    const bridge = new EmulatorBridge()
    const old = session('device-1')
    const replacement = {
      ...old,
      helperPid: 4321,
      streamUrl: 'http://127.0.0.1:3200/new',
      wsUrl: 'ws://127.0.0.1:3200/new'
    }
    bridge.registerActiveEmulator('wt-1', old, { managed: true })
    bridge.registerActiveEmulator('wt-2', old, { managed: true })
    vi.spyOn(bridge, 'getReusableActiveForWorktree').mockResolvedValue(null)
    vi.spyOn(bridge, 'stopActiveForSwitch').mockResolvedValue(null)
    let finishRelease!: () => void
    vi.spyOn(bridge, 'acquireHelperForDevice').mockResolvedValue({
      info: replacement,
      release: () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve
        })
    })
    const send = vi.fn()
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveEmulatorWorkspaceId: vi.fn(async () => 'wt-1'),
      resolveEmulatorCleanupWorkspaceId: vi.fn(async () => 'wt-1'),
      getAuthoritativeWindow: () => ({ webContents: { send } }) as never,
      getSettings: () => ({ mobileEmulatorEnabled: true })
    })
    const first = commands.emulatorAttach({
      worktree: 'wt-1',
      device: 'device-1',
      userInitiated: true,
      focus: true
    })
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith('ui:emulatorAutoAttach', {
        worktreeId: 'wt-2',
        info: replacement
      })
    )
    await commands.emulatorAttach({ worktree: 'wt-1', device: 'missing', userInitiated: true })
    finishRelease()
    await expect(first).rejects.toMatchObject({ code: 'emulator_attach_superseded' })
    expect(send).not.toHaveBeenCalledWith('emulator:pane-focus', { worktreeId: 'wt-1' })
  })

  it('does not publish a reused session after teardown closes admission', async () => {
    const bridge = new EmulatorBridge()
    bridge.registerActiveEmulator('wt-1', session('device-1'), { managed: true })
    const ios = bridge.listBackends().find((backend) => backend.kind === 'ios')!
    let finish!: (value: boolean) => void
    vi.spyOn(ios, 'isSessionReusable').mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
    )
    vi.spyOn(ios, 'stopHelperForDevice').mockResolvedValue()
    vi.spyOn(ios, 'stopOwnedHelpers').mockResolvedValue()
    const send = vi.fn()
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveEmulatorWorkspaceId: vi.fn(async () => 'wt-1'),
      resolveEmulatorCleanupWorkspaceId: vi.fn(async () => 'wt-1'),
      getAuthoritativeWindow: () => ({ webContents: { send } }) as never,
      getSettings: () => ({ mobileEmulatorEnabled: true })
    })
    const attaching = commands.emulatorAttach({ worktree: 'wt-1' })
    await vi.waitFor(() => expect(finish).toBeDefined())
    await bridge.destroyAllSessions()
    finish(true)
    await expect(attaching).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })

  it('does not report an attached endpoint after the workspace detached during lease release', async () => {
    const bridge = new EmulatorBridge()
    const info = session('device-1')
    vi.spyOn(bridge, 'getReusableActiveForWorktree').mockResolvedValue(null)
    vi.spyOn(bridge, 'stopActiveForSwitch').mockResolvedValue(null)
    vi.spyOn(bridge, 'acquireHelperForDevice').mockResolvedValue({
      info,
      release: async () => {
        bridge.unregisterActiveEmulator('wt-1')
      }
    })
    const send = vi.fn()
    const commands = new RuntimeEmulatorCommands({
      getEmulatorBridge: () => bridge,
      resolveEmulatorWorkspaceId: vi.fn(async () => 'wt-1'),
      resolveEmulatorCleanupWorkspaceId: vi.fn(async () => 'wt-1'),
      getAuthoritativeWindow: () => ({ webContents: { send } }) as never,
      getSettings: () => ({ mobileEmulatorEnabled: true })
    })
    await expect(
      commands.emulatorAttach({ worktree: 'wt-1', device: 'device-1' })
    ).rejects.toMatchObject({ code: 'emulator_attach_superseded' })
    expect(send).not.toHaveBeenCalled()
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
