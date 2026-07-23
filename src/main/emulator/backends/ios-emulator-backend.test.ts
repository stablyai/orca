import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimulatorDevice } from '../simctl-simulator-devices'
import type { ServeSimHelperProcess } from '../serve-sim-helper-processes'

const {
  ensureSimulatorBootedMock,
  execServeSimCommandMock,
  hideNativeSimulatorAppMock,
  killServeSimHelperProcessesForDeviceMock,
  listSimulatorDevicesMock,
  listServeSimHelperProcessesForDeviceMock,
  shutdownSimulatorDeviceMock,
  sendEmulatorGestureSequenceMock,
  parseServeSimDetachedSessionMock
} = vi.hoisted(() => ({
  ensureSimulatorBootedMock: vi.fn(async () => {}),
  execServeSimCommandMock: vi.fn(async (_executable?: unknown, _args?: string[]) => ({})),
  hideNativeSimulatorAppMock: vi.fn(async () => {}),
  killServeSimHelperProcessesForDeviceMock: vi.fn(async () => {}),
  listSimulatorDevicesMock: vi.fn(async (): Promise<SimulatorDevice[]> => []),
  listServeSimHelperProcessesForDeviceMock: vi.fn(async (): Promise<ServeSimHelperProcess[]> => []),
  shutdownSimulatorDeviceMock: vi.fn(async () => {}),
  sendEmulatorGestureSequenceMock: vi.fn(async () => {}),
  parseServeSimDetachedSessionMock: vi.fn()
}))

vi.mock('../serve-sim-execution', () => ({
  execServeSimCommand: execServeSimCommandMock,
  parseServeSimCommandArgs: vi.fn((input: string) => input.split(' ').filter(Boolean)),
  resolveServeSimExecutable: vi.fn(() => ({ command: '/serve-sim', env: {} })),
  stripEmulatorTargetArgs: vi.fn((args: string[]) => args)
}))

vi.mock('../simctl-simulator-devices', () => ({
  ensureSimulatorBooted: ensureSimulatorBootedMock,
  listSimulatorDevices: listSimulatorDevicesMock,
  resolveSimulatorUdid: vi.fn(async (device: string) => device),
  shutdownSimulatorDevice: shutdownSimulatorDeviceMock
}))

vi.mock('../serve-sim-helper-processes', () => ({
  killServeSimHelperProcessesForDevice: killServeSimHelperProcessesForDeviceMock,
  listServeSimHelperProcessesForDevice: listServeSimHelperProcessesForDeviceMock
}))

vi.mock('../simulator-app-visibility', () => ({
  hideNativeSimulatorApp: hideNativeSimulatorAppMock
}))

vi.mock('../emulator-gesture-sender', () => ({
  sendEmulatorGestureSequence: sendEmulatorGestureSequenceMock
}))

vi.mock('../serve-sim-detached-session', () => ({
  parseServeSimDetachedSession: parseServeSimDetachedSessionMock
}))

import { EmulatorError } from '../emulator-errors'
import { IosEmulatorBackend } from './ios-emulator-backend'

const EXECUTABLE = { command: '/serve-sim', env: {} }

describe('IosEmulatorBackend', () => {
  beforeEach(() => {
    ensureSimulatorBootedMock.mockReset()
    ensureSimulatorBootedMock.mockImplementation(async () => {})
    execServeSimCommandMock.mockReset()
    execServeSimCommandMock.mockImplementation(async () => ({}))
    listSimulatorDevicesMock.mockReset()
    listSimulatorDevicesMock.mockImplementation(async () => [])
    listServeSimHelperProcessesForDeviceMock.mockReset()
    listServeSimHelperProcessesForDeviceMock.mockImplementation(async () => [
      { pid: 1234, command: 'serve-sim-bin device-1' }
    ])
    killServeSimHelperProcessesForDeviceMock.mockReset()
    killServeSimHelperProcessesForDeviceMock.mockImplementation(async () => {})
    hideNativeSimulatorAppMock.mockReset()
    hideNativeSimulatorAppMock.mockImplementation(async () => {})
    shutdownSimulatorDeviceMock.mockReset()
    shutdownSimulatorDeviceMock.mockImplementation(async () => {})
    sendEmulatorGestureSequenceMock.mockReset()
    sendEmulatorGestureSequenceMock.mockImplementation(async () => {})
    parseServeSimDetachedSessionMock.mockReset()
  })

  it('declares ios kind, mjpeg codec, and only the ax explicit-verb capability', () => {
    const backend = new IosEmulatorBackend()
    expect(backend.kind).toBe('ios')
    expect(backend.streamCodec).toBe('mjpeg')
    expect(backend.capabilities).toEqual({
      install: false,
      launch: false,
      permissions: false,
      accessibilityTree: true,
      logcat: false
    })
  })

  it('fetches the accessibility tree from the session ax endpoint and rejects without one', async () => {
    const fetchAccessibilityTree = vi.fn(async () => ({ elements: [] }))
    const backend = new IosEmulatorBackend({ fetchAccessibilityTree })
    await expect(
      backend.accessibilityTree('device-1', 'http://127.0.0.1:3100/ax')
    ).resolves.toEqual({ elements: [] })
    expect(fetchAccessibilityTree).toHaveBeenCalledWith('http://127.0.0.1:3100/ax')
    await expect(backend.accessibilityTree('device-1', null)).rejects.toMatchObject({
      code: 'emulator_no_active'
    })
  })

  it('taps via serve-sim with the resolved device', async () => {
    const backend = new IosEmulatorBackend()
    await backend.tap('iPhone 16 Pro', 0.5, 0.7)
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      EXECUTABLE,
      ['tap', '0.5', '0.7', '-d', 'iPhone 16 Pro'],
      undefined
    )
  })

  it('types and presses hardware buttons via serve-sim', async () => {
    const backend = new IosEmulatorBackend()
    await backend.type('device-1', 'hi')
    await backend.button('device-1', 'home')
    await backend.rotate('device-1', 'landscape_left')
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      EXECUTABLE,
      ['type', 'hi', '-d', 'device-1'],
      undefined
    )
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      EXECUTABLE,
      ['button', 'home', '-d', 'device-1'],
      undefined
    )
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      EXECUTABLE,
      ['rotate', 'landscape_left', '-d', 'device-1'],
      undefined
    )
  })

  it('execs a raw command with the device appended as json', async () => {
    const backend = new IosEmulatorBackend()
    await backend.exec('device-1', 'ca-debug blended on')
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      EXECUTABLE,
      ['ca-debug', 'blended', 'on', '-d', 'device-1'],
      { json: true }
    )
  })

  it('sends a gesture over the provided ws url and rejects without one', async () => {
    const backend = new IosEmulatorBackend()
    const points = [
      { type: 'begin' as const, x: 0.1, y: 0.1 },
      { type: 'end' as const, x: 0.2, y: 0.2 }
    ]
    await backend.gesture('device-1', points, 'ws://127.0.0.1:3100/device-1')
    expect(sendEmulatorGestureSequenceMock).toHaveBeenCalledWith(
      'ws://127.0.0.1:3100/device-1',
      points
    )
    await expect(backend.gesture('device-1', points, null)).rejects.toMatchObject({
      code: 'emulator_no_active'
    })
  })

  it('maps simulator devices to the cross-backend device shape', async () => {
    listSimulatorDevicesMock.mockResolvedValue([
      {
        name: 'iPhone 17 Pro',
        udid: 'udid-1',
        state: 'Booted',
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0'
      }
    ])
    const backend = new IosEmulatorBackend()
    const devices = await backend.listDevices()
    expect(devices).toEqual([
      {
        backend: 'ios',
        id: 'udid-1',
        name: 'iPhone 17 Pro',
        state: 'booted',
        detail: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
        isAvailable: true
      }
    ])
  })

  it('starts a session and tags it as mjpeg', async () => {
    parseServeSimDetachedSessionMock.mockReturnValue({
      deviceUdid: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102',
      helperPid: 1234
    })
    const backend = new IosEmulatorBackend({ waitForEndpointReady: async () => true })
    const info = await backend.startSession('device-1')
    expect(info.deviceUdid).toBe('device-1')
    expect(info.streamCodec).toBe('mjpeg')
    expect(hideNativeSimulatorAppMock).toHaveBeenCalledTimes(1)
  })

  it('recycles the device and retries when the helper finds no framebuffer', async () => {
    // The real-world failure: simctl reports Booted but the display IO ports
    // never came up, so serve-sim --detach dies with the framebuffer error.
    execServeSimCommandMock
      .mockRejectedValueOnce(
        new EmulatorError(
          'emulator_error',
          'Helper failed:\n[main] Starting serve-sim-bin\n[main] Failed to start capture: No framebuffer display descriptor found'
        )
      )
      .mockResolvedValueOnce({})
    parseServeSimDetachedSessionMock.mockReturnValue({
      deviceUdid: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102',
      helperPid: 1234
    })
    const backend = new IosEmulatorBackend({ waitForEndpointReady: async () => true })
    const info = await backend.startSession('device-1')
    expect(info.deviceUdid).toBe('device-1')
    expect(shutdownSimulatorDeviceMock).toHaveBeenCalledWith('device-1')
    // Booted once up front, again after the recycle shutdown.
    expect(ensureSimulatorBootedMock).toHaveBeenCalledTimes(2)
    expect(execServeSimCommandMock).toHaveBeenCalledTimes(2)
  })

  it('does not recycle the device for unrelated helper start failures', async () => {
    execServeSimCommandMock.mockRejectedValueOnce(
      new EmulatorError('emulator_error', 'Helper failed:\n[main] Port 3100 already in use')
    )
    const backend = new IosEmulatorBackend({ waitForEndpointReady: async () => true })
    await expect(backend.startSession('device-1')).rejects.toMatchObject({
      message: expect.stringContaining('Port 3100 already in use')
    })
    expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
    expect(execServeSimCommandMock).toHaveBeenCalledTimes(1)
  })

  it('propagates mid-recycle failures instead of masking them', async () => {
    execServeSimCommandMock.mockRejectedValue(
      new EmulatorError(
        'emulator_error',
        'Helper failed:\n[main] Failed to start capture: No framebuffer display descriptor found'
      )
    )
    shutdownSimulatorDeviceMock.mockRejectedValueOnce(
      new EmulatorError('emulator_error', 'xcrun simctl shutdown timed out')
    )
    const backend = new IosEmulatorBackend({ waitForEndpointReady: async () => true })
    await expect(backend.startSession('device-1')).rejects.toMatchObject({
      message: expect.stringContaining('timed out')
    })
    expect(execServeSimCommandMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces an actionable error when the display stays wedged after one recycle', async () => {
    execServeSimCommandMock.mockRejectedValue(
      new EmulatorError(
        'emulator_error',
        'Helper failed:\n[main] Failed to start capture: No framebuffer display descriptor found'
      )
    )
    const backend = new IosEmulatorBackend({ waitForEndpointReady: async () => true })
    await expect(backend.startSession('device-1')).rejects.toMatchObject({
      code: 'emulator_helper_failed',
      // Actionable headline plus the raw helper log for diagnosis.
      message: expect.stringMatching(/simctl erase[\s\S]*No framebuffer display descriptor found/)
    })
    // Exactly one recycle attempt; no shutdown/boot loop against a broken device.
    expect(shutdownSimulatorDeviceMock).toHaveBeenCalledTimes(1)
    expect(execServeSimCommandMock).toHaveBeenCalledTimes(2)
  })

  it('does not recycle more than once during one start attempt', async () => {
    let detachCalls = 0
    execServeSimCommandMock.mockImplementation(
      async (_executable?: unknown, args: string[] = []) => {
        if (args[0] !== '--detach') {
          return {}
        }
        detachCalls += 1
        if (detachCalls === 2) {
          return {}
        }
        throw new EmulatorError(
          'emulator_error',
          'Helper failed:\n[main] Failed to start capture: No framebuffer display descriptor found'
        )
      }
    )
    parseServeSimDetachedSessionMock.mockReturnValue({
      deviceUdid: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102',
      helperPid: 1234
    })
    const backend = new IosEmulatorBackend({ waitForEndpointReady: async () => false })

    await expect(backend.startSession('device-1')).rejects.toMatchObject({
      code: 'emulator_helper_failed',
      message: expect.stringContaining('even after a reboot')
    })
    expect(detachCalls).toBe(3)
    expect(shutdownSimulatorDeviceMock).toHaveBeenCalledTimes(1)
    expect(ensureSimulatorBootedMock).toHaveBeenCalledTimes(2)
  })

  it('stops a helper via serve-sim kill plus the orphan sweep', async () => {
    const backend = new IosEmulatorBackend()
    await backend.stopHelperForDevice('device-1', { helperPid: 1234, includeOrphaned: true })
    expect(execServeSimCommandMock).toHaveBeenCalledWith(
      EXECUTABLE,
      ['--kill', '-q', 'device-1'],
      undefined
    )
    expect(killServeSimHelperProcessesForDeviceMock).toHaveBeenCalledWith('device-1', {
      helperPid: 1234,
      includeOrphaned: true
    })
  })

  it('treats a session as reusable only when reachable and helper-backed', async () => {
    const reachable = new IosEmulatorBackend({ waitForEndpointReady: async () => true })
    const info = {
      deviceUdid: 'device-1',
      streamUrl: 'http://127.0.0.1:3100/device-1',
      wsUrl: 'ws://127.0.0.1:3100/device-1',
      helperPid: 1234
    }
    expect(await reachable.isSessionReusable(info)).toBe(true)

    const unreachable = new IosEmulatorBackend({ waitForEndpointReady: async () => false })
    expect(await unreachable.isSessionReusable(info)).toBe(false)
  })
})
