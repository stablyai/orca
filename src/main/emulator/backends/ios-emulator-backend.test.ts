import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimulatorDevice } from '../simctl-simulator-devices'
import type { ServeSimHelperProcess } from '../serve-sim-helper-processes'
import type * as ServeSimExecution from '../serve-sim-execution'
import type * as ProcessHost from '@orca/process-host'

const {
  ensureSimulatorBootedMock,
  execServeSimCommandMock,
  hideNativeSimulatorAppMock,
  killServeSimHelperProcessesForDeviceMock,
  listSimulatorDevicesMock,
  listServeSimHelperProcessesForDeviceMock,
  shutdownSimulatorDeviceMock,
  sendEmulatorGestureSequenceMock,
  parseServeSimDetachedSessionMock,
  netFetchMock,
  notifyutilState
} = vi.hoisted(() => ({
  notifyutilState: { stdout: 'com.apple.coredevice.dtuhidd.active 0\n' },
  ensureSimulatorBootedMock: vi.fn(async () => {}),
  execServeSimCommandMock: vi.fn(async (_executable?: unknown, _args?: string[]) => ({})),
  hideNativeSimulatorAppMock: vi.fn(async () => {}),
  killServeSimHelperProcessesForDeviceMock: vi.fn(async () => {}),
  listSimulatorDevicesMock: vi.fn(async (): Promise<SimulatorDevice[]> => []),
  listServeSimHelperProcessesForDeviceMock: vi.fn(async (): Promise<ServeSimHelperProcess[]> => []),
  shutdownSimulatorDeviceMock: vi.fn(async () => {}),
  sendEmulatorGestureSequenceMock: vi.fn(async () => {}),
  parseServeSimDetachedSessionMock: vi.fn(),
  netFetchMock: vi.fn()
}))

vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessHost>()),
  runProcess: vi.fn(async () => ({ code: 0, stdout: notifyutilState.stdout, stderr: '' }))
}))

vi.mock('../../network/http-client', () => ({
  getMainHttpClient: () => ({ fetch: netFetchMock })
}))

vi.mock('../serve-sim-execution', async (importOriginal) => ({
  execServeSimCommand: execServeSimCommandMock,
  parseServeSimCommandArgs: vi.fn((input: string) => input.split(' ').filter(Boolean)),
  resolveServeSimExecutable: vi.fn(() => ({ command: '/serve-sim', env: {} })),
  serveSimKillArgs: (await importOriginal<typeof ServeSimExecution>()).serveSimKillArgs,
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
    netFetchMock.mockReset()
    notifyutilState.stdout = 'com.apple.coredevice.dtuhidd.active 0\n'
  })

  it('refuses touch and keyboard input instead of reporting success while Device Hub holds it', async () => {
    notifyutilState.stdout = 'com.apple.coredevice.dtuhidd.active 1\n'
    const backend = new IosEmulatorBackend()
    const points = [
      { type: 'begin' as const, x: 0.1, y: 0.1 },
      { type: 'end' as const, x: 0.2, y: 0.2 }
    ]
    const blocked = { code: 'emulator_input_blocked' }
    await expect(backend.tap('device-1', 0.5, 0.5)).rejects.toMatchObject(blocked)
    await expect(backend.type('device-1', 'hi')).rejects.toMatchObject(blocked)
    await expect(
      backend.gesture('device-1', points, 'ws://127.0.0.1:3100/x')
    ).rejects.toMatchObject(blocked)
    expect(execServeSimCommandMock).not.toHaveBeenCalled()
    expect(sendEmulatorGestureSequenceMock).not.toHaveBeenCalled()
  })

  it('sends taps in raw panel coordinates so serve-sim does not remap landscape twice', async () => {
    const backend = new IosEmulatorBackend()
    await backend.tap('device-1', 0.2, 0.3)
    const args = execServeSimCommandMock.mock.calls.at(-1)?.[1]
    expect(args?.slice(0, 3)).toEqual(['tap', '0.2', '0.3'])
    expect(args).toContain('--raw')
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

  it('keeps a reachable helper when its process lookup fails', async () => {
    listServeSimHelperProcessesForDeviceMock.mockRejectedValueOnce(new Error('ps failed'))
    parseServeSimDetachedSessionMock.mockReturnValue({
      deviceUdid: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102',
      helperPid: 1234
    })
    const backend = new IosEmulatorBackend({ waitForEndpointReady: async () => true })

    await expect(backend.startSession('device-1')).resolves.toMatchObject({
      deviceUdid: 'device-1'
    })
    expect(killServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
  })
})
