import { beforeEach, describe, expect, it, vi } from 'vitest'
import packageJson from '../../../../package.json'
import { cancelTrackingResponse } from '../../lib/unread-response-body.test-fixtures'
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
import { readServeSimHelperVersion } from '../serve-sim-endpoint-readiness'
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
    netFetchMock.mockReset()
    notifyutilState.stdout = 'com.apple.coredevice.dtuhidd.active 0\n'
    netFetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ serve_sim: { version: packageJson.dependencies['serve-sim'] } }),
          {
            status: 200
          }
        )
    )
  })

  it('advertises the iOS accessibility tree capability', () => {
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

  it('fetches and normalizes the serve-sim accessibility tree', async () => {
    const raw = [
      {
        type: 'Application',
        role_description: 'application',
        AXLabel: 'Demo',
        enabled: true,
        frame: { x: 0, y: 0, width: 400, height: 800 },
        children: [
          {
            type: 'Button',
            role_description: 'button',
            AXLabel: 'Continue',
            AXValue: '',
            enabled: true,
            frame: { x: 100, y: 400, width: 200, height: 50 },
            children: []
          }
        ]
      }
    ]
    netFetchMock.mockResolvedValue(new Response(JSON.stringify(raw), { status: 200 }))
    const backend = new IosEmulatorBackend()

    await expect(
      backend.accessibilityTree('device-1', 'http://127.0.0.1:3100/ax')
    ).resolves.toEqual([
      {
        role: 'application',
        type: 'Application',
        label: 'Demo',
        value: '',
        enabled: true,
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [
          {
            role: 'button',
            type: 'Button',
            label: 'Continue',
            value: '',
            enabled: true,
            frame: { x: 0.25, y: 0.5, width: 0.5, height: 0.0625 },
            children: []
          }
        ]
      }
    ])
    expect(netFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3100/ax',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('reports missing sessions and temporarily unavailable AX endpoints', async () => {
    const backend = new IosEmulatorBackend()
    await expect(backend.accessibilityTree('device-1')).rejects.toMatchObject({
      code: 'emulator_no_active'
    })

    netFetchMock.mockResolvedValue(new Response('{"error":"ax_unavailable"}', { status: 503 }))
    await expect(
      backend.accessibilityTree('device-1', 'http://127.0.0.1:3100/ax')
    ).rejects.toMatchObject({ code: 'emulator_helper_failed' })
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

  it('enables AVCC only after verifying the live helper while retaining its MJPEG URL', async () => {
    parseServeSimDetachedSessionMock.mockReturnValue({
      deviceUdid: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/helper/device-1/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102/helper/device-1/ws',
      helperPid: 1234
    })
    const backend = new IosEmulatorBackend({ waitForEndpointReady: async () => true })
    const info = await backend.startSession('device-1')

    expect(info.streamUrl).toBe('http://127.0.0.1:3102/helper/device-1/stream.mjpeg')
    expect(info.avccStreamUrl).toBe('http://127.0.0.1:3102/helper/device-1/stream.avcc')
    expect(info.streamCodec).toBe('mjpeg')
    expect(netFetchMock).toHaveBeenCalledExactlyOnceWith(
      'http://127.0.0.1:3102/api/diagnostics',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(execServeSimCommandMock).toHaveBeenCalledTimes(1)
    expect(hideNativeSimulatorAppMock).toHaveBeenCalledTimes(1)
  })
  it('preserves a ready shared helper when diagnostics is rate limited', async () => {
    netFetchMock.mockImplementation(async () => new Response('Rate limited', { status: 429 }))
    const existing = {
      deviceUdid: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/helper/device-1/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102/helper/device-1/ws',
      helperPid: 1234
    }
    parseServeSimDetachedSessionMock.mockReturnValue(existing)
    const backend = new IosEmulatorBackend({ waitForEndpointReady: async () => true })

    const info = await backend.startSession('device-1')

    expect(info.streamUrl).toBe(existing.streamUrl)
    expect(info.avccStreamUrl).toBeUndefined()
    expect(killServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
    expect(execServeSimCommandMock.mock.calls.some(([, args]) => args?.includes('--kill'))).toBe(
      false
    )
    expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
    expect(
      await backend.isSessionReusable({
        ...existing,
        avccStreamUrl: 'http://127.0.0.1:3102/helper/device-1/stream.avcc'
      })
    ).toBe(true)
  })

  it.each([
    ['an old helper without diagnostics', 'Not found', 404],
    ['an identified old helper', '{"serve_sim":{"version":"0.1.47"}}', 200],
    ['an unmeasured newer helper', '{"serve_sim":{"version":"0.1.49-beta.140.2"}}', 200]
  ])(
    'preserves %s as a ready shared JPEG helper without rebooting the guest',
    async (_name, body, status) => {
      netFetchMock.mockResolvedValueOnce(new Response(body, { status }))
      const existing = {
        deviceUdid: 'device-1',
        streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
        wsUrl: 'ws://127.0.0.1:3102',
        helperPid: 1234
      }
      parseServeSimDetachedSessionMock.mockReturnValue(existing)
      const waitForEndpointReady = vi.fn(async () => true)
      const backend = new IosEmulatorBackend({ waitForEndpointReady })

      const info = await backend.startSession('device-1')

      expect(info).toEqual({
        ...existing,
        avccStreamUrl: undefined,
        streamCodec: 'mjpeg',
        backend: 'ios'
      })
      expect(waitForEndpointReady).toHaveBeenCalledTimes(1)
      expect(execServeSimCommandMock.mock.calls.map(([, args]) => args)).toEqual([
        ['--detach', '-q', 'device-1']
      ])
      expect(killServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
      expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
      expect(ensureSimulatorBootedMock).toHaveBeenCalledTimes(1)
      expect(await backend.isSessionReusable(info)).toBe(true)
      expect(netFetchMock.mock.calls.map(([url]) => url)).toEqual([
        'http://127.0.0.1:3102/api/diagnostics'
      ])
    }
  )

  it.each([
    { status: 404, version: 404 },
    { status: 429, version: null },
    { status: 500, version: null }
  ])(
    'cancels non-OK diagnostics bodies (HTTP $status) without changing the version result',
    async ({ status, version }) => {
      let cancelled = false
      const response = cancelTrackingResponse(status, () => {
        cancelled = true
      })
      netFetchMock.mockResolvedValueOnce(response)

      expect(await readServeSimHelperVersion('http://127.0.0.1:3102/stream.mjpeg')).toBe(version)
      expect(cancelled).toBe(true)
      expect(response.bodyUsed).toBe(true)
    }
  )

  it.each([
    ['missing diagnostics', 'Not found', 404],
    ['invalid JSON', '{', 200],
    ['a null response', 'null', 200],
    ['an invalid version type', '{"serve_sim":{"version":140}}', 200],
    ['an unmeasured helper', '{"serve_sim":{"version":"0.1.49-beta.140.2"}}', 200]
  ])('retains JPEG when a ready replacement has %s', async (_name, body, status) => {
    netFetchMock.mockResolvedValueOnce(new Response(body, { status }))
    parseServeSimDetachedSessionMock.mockReturnValue({
      deviceUdid: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102',
      helperPid: 1234
    })
    const waitForEndpointReady = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const backend = new IosEmulatorBackend({ waitForEndpointReady })

    const info = await backend.startSession('device-1')

    expect(info.streamUrl).toBe('http://127.0.0.1:3102/stream.mjpeg')
    expect(info.avccStreamUrl).toBeUndefined()
    expect(info.streamCodec).toBe('mjpeg')
    expect(waitForEndpointReady).toHaveBeenCalledTimes(2)
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(execServeSimCommandMock).toHaveBeenCalledTimes(3)
    expect(killServeSimHelperProcessesForDeviceMock).toHaveBeenCalledTimes(1)
    expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
    expect(ensureSimulatorBootedMock).toHaveBeenCalledTimes(1)
  })

  it('uses the same retry budget for readiness and an unverifiable replacement', async () => {
    netFetchMock.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'))
    parseServeSimDetachedSessionMock.mockReturnValue({
      deviceUdid: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102',
      helperPid: 1234
    })
    const waitForEndpointReady = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const backend = new IosEmulatorBackend({ waitForEndpointReady })

    const info = await backend.startSession('device-1')

    expect(info.streamUrl).toBe('http://127.0.0.1:3102/stream.mjpeg')
    expect(info.avccStreamUrl).toBeUndefined()
    expect(waitForEndpointReady).toHaveBeenCalledTimes(2)
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(killServeSimHelperProcessesForDeviceMock).toHaveBeenCalledTimes(1)
    expect(execServeSimCommandMock).toHaveBeenCalledTimes(3)
    expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
  })

  it('cleans up and rejects an unreachable replacement without another restart', async () => {
    parseServeSimDetachedSessionMock.mockReturnValue({
      deviceUdid: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3102',
      helperPid: 1234
    })
    const waitForEndpointReady = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    const backend = new IosEmulatorBackend({ waitForEndpointReady })

    await expect(backend.startSession('device-1')).rejects.toMatchObject({
      code: 'emulator_helper_failed'
    })

    expect(waitForEndpointReady).toHaveBeenCalledTimes(2)
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(killServeSimHelperProcessesForDeviceMock).toHaveBeenCalledTimes(2)
    expect(execServeSimCommandMock).toHaveBeenCalledTimes(4)
    expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
  })

  it('retains non-loopback streams without probing or restarting their helper', async () => {
    parseServeSimDetachedSessionMock.mockReturnValue({
      deviceUdid: 'device-1',
      streamUrl: 'https://remote.example/helper/device-1/stream.mjpeg',
      wsUrl: 'wss://remote.example/helper/device-1/ws',
      helperPid: 1234
    })
    const backend = new IosEmulatorBackend({ waitForEndpointReady: async () => true })

    const info = await backend.startSession('device-1')

    expect(info.avccStreamUrl).toBeUndefined()
    expect(info.streamUrl).toBe('https://remote.example/helper/device-1/stream.mjpeg')
    expect(netFetchMock).not.toHaveBeenCalled()
    expect(killServeSimHelperProcessesForDeviceMock).not.toHaveBeenCalled()
    expect(execServeSimCommandMock).toHaveBeenCalledTimes(1)
  })

  it('recycles the device and retries when the helper finds no framebuffer', async () => {
    // CoreSimulator can report Booted while framebuffer ports remain unavailable.
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
      message: expect.stringMatching(/simctl erase[\s\S]*No framebuffer display descriptor found/)
    })
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
      ['--kill=device-1', '-q'],
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

  it('does not reuse advertised video after the live helper becomes unverifiable', async () => {
    const backend = new IosEmulatorBackend({ waitForEndpointReady: async () => true })
    const info = {
      deviceUdid: 'device-1',
      streamUrl: 'http://127.0.0.1:3102/helper/device-1/stream.mjpeg',
      avccStreamUrl: 'http://127.0.0.1:3102/helper/device-1/stream.avcc',
      wsUrl: 'ws://127.0.0.1:3102/helper/device-1/ws',
      helperPid: 1234
    }
    expect(await backend.isSessionReusable(info)).toBe(true)

    netFetchMock.mockResolvedValueOnce(new Response('Not found', { status: 404 }))
    expect(await backend.isSessionReusable(info)).toBe(false)
    expect(execServeSimCommandMock).not.toHaveBeenCalled()
    expect(shutdownSimulatorDeviceMock).not.toHaveBeenCalled()
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
