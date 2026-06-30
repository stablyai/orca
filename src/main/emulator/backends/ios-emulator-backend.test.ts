import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimulatorDevice } from '../simctl-simulator-devices'
import type { ServeSimHelperProcess } from '../serve-sim-helper-processes'

const {
  execServeSimCommandMock,
  hideNativeSimulatorAppMock,
  killServeSimHelperProcessesForDeviceMock,
  listSimulatorDevicesMock,
  listServeSimHelperProcessesForDeviceMock,
  shutdownSimulatorDeviceMock,
  sendEmulatorGestureSequenceMock,
  parseServeSimDetachedSessionMock
} = vi.hoisted(() => ({
  execServeSimCommandMock: vi.fn(async () => ({})),
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
  ensureSimulatorBooted: vi.fn(async () => {}),
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

import { IosEmulatorBackend } from './ios-emulator-backend'

const EXECUTABLE = { command: '/serve-sim', env: {} }

describe('IosEmulatorBackend', () => {
  beforeEach(() => {
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

  it('declares ios kind, mjpeg codec, and no explicit-verb capabilities', () => {
    const backend = new IosEmulatorBackend()
    expect(backend.kind).toBe('ios')
    expect(backend.streamCodec).toBe('mjpeg')
    expect(backend.capabilities).toEqual({
      install: false,
      launch: false,
      permissions: false,
      accessibilityTree: false,
      logcat: false
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
