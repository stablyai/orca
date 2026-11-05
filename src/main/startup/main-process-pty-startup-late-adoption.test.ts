import { afterEach, expect, it, vi } from 'vitest'
import type { DaemonProviderInitOptions } from '../daemon/daemon-provider-init'

const { initMock, scheduleMock, getDaemonProviderMock, startServicesMock } = vi.hoisted(() => ({
  initMock: vi.fn<(signal?: AbortSignal, options?: DaemonProviderInitOptions) => Promise<void>>(),
  scheduleMock: vi.fn<(adopt: () => Promise<void>, isQuitting: () => boolean) => void>(),
  getDaemonProviderMock: vi.fn<() => object | null>(() => null),
  startServicesMock: vi.fn()
}))
vi.mock('../daemon/daemon-provider-init', () => ({ initDaemonPtyProvider: initMock }))
vi.mock('../daemon/daemon-late-adoption', () => ({ scheduleLateDaemonAdoption: scheduleMock }))
vi.mock('../daemon/daemon-provider-state', () => ({
  getDaemonProvider: getDaemonProviderMock,
  listLiveDaemonPtyIds: vi.fn(async () => null)
}))
vi.mock('./first-window-startup-services', () => ({
  startFirstWindowStartupServices: startServicesMock.mockImplementation(() => ({
    firstWindowReady: new Promise(() => {}),
    localPtyReady: new Promise(() => {}),
    localPtyProviderReady: new Promise(() => {})
  }))
}))

import { startTerminalRuntimeStartupServices } from './main-process-pty-startup'

type StartDaemon = (signal: AbortSignal) => Promise<void>

function startDaemonPtyProvider(): StartDaemon {
  startTerminalRuntimeStartupServices()
  return startServicesMock.mock.calls.at(-1)![0].startDaemonPtyProvider
}

afterEach(() => {
  vi.clearAllMocks()
})

it('schedules adoption of a late host that keeps in-process terminals when startup fails', async () => {
  initMock.mockRejectedValueOnce(new Error('terminal host not ready'))

  await expect(startDaemonPtyProvider()(new AbortController().signal)).rejects.toThrow(
    'terminal host not ready'
  )

  expect(scheduleMock).toHaveBeenCalledOnce()
  initMock.mockResolvedValueOnce(undefined)
  await scheduleMock.mock.calls[0]![0]()
  expect(initMock).toHaveBeenLastCalledWith(
    undefined,
    expect.objectContaining({ inProcessPtysMayExist: true })
  )
})

it('does not schedule adoption once startup installed a provider', async () => {
  initMock.mockResolvedValueOnce(undefined)
  getDaemonProviderMock.mockReturnValue({})

  await startDaemonPtyProvider()(new AbortController().signal)

  expect(scheduleMock).not.toHaveBeenCalled()
})
