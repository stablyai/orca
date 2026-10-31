import { expect, it, vi } from 'vitest'

const { noteFallbackMock, startServicesMock } = vi.hoisted(() => ({
  noteFallbackMock: vi.fn(),
  startServicesMock: vi.fn()
}))
vi.mock('../daemon/daemon-startup-fallback', () => ({
  noteDaemonStartupFallback: noteFallbackMock
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./first-window-startup-services', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startFirstWindowStartupServices: startServicesMock.mockImplementation(() => ({
    firstWindowReady: new Promise(() => {}),
    localPtyReady: new Promise(() => {}),
    localPtyProviderReady: new Promise(() => {})
  }))
}))

import { startTerminalRuntimeStartupServices } from './main-process-pty-startup'

it('records the in-process fallback so the sidebar can warn about it', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  startTerminalRuntimeStartupServices()
  const { onDaemonError } = startServicesMock.mock.calls.at(-1)![0]

  expect(noteFallbackMock).not.toHaveBeenCalled()
  onDaemonError(new Error('daemon PTY provider startup timed out'))
  expect(noteFallbackMock).toHaveBeenCalledOnce()
})
