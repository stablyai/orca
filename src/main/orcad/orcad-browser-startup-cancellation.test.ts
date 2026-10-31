import { beforeEach, expect, it, vi } from 'vitest'
import { resolveOrcadBrowserProvider } from './orcad-browser-provider'

const { start, stop, chromiumStart } = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  chromiumStart: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), access: vi.fn() }))
vi.mock('./electron-serve-browser-process', () => ({
  ElectronServeBrowserProcess: class {
    start = start
    stop = stop
  }
}))
vi.mock('./external-chromium-browser-process', () => ({
  ExternalChromiumBrowserProcess: class {
    start = chromiumStart
  }
}))
beforeEach(() => vi.resetAllMocks())

const options = {
  userDataPath: '/fixture',
  resolveInstalledElectronExecutable: async () => '/fixture/electron',
  resolveAgentBrowserBinary: () => '/fixture/driver',
  environment: { ORCA_BROWSER_EXECUTABLE: '/fixture/chromium' }
}

it('does not launch a provider after pre-cancellation', async () => {
  await expect(
    resolveOrcadBrowserProvider({ ...options, signal: AbortSignal.abort() })
  ).resolves.toBeNull()
  expect(start).not.toHaveBeenCalled()
  expect(chromiumStart).not.toHaveBeenCalled()
})

it('cleans cancelled Electron startup without launching a fallback', async () => {
  const controller = new AbortController()
  start.mockImplementation(async () => {
    controller.abort()
    controller.signal.throwIfAborted()
  })
  await expect(
    resolveOrcadBrowserProvider({ ...options, signal: controller.signal })
  ).resolves.toBeNull()
  expect(stop).toHaveBeenCalledOnce()
  expect(chromiumStart).not.toHaveBeenCalled()
})

it('propagates failed cleanup even when startup was cancelled', async () => {
  const controller = new AbortController()
  start.mockImplementation(async () => {
    controller.abort()
    controller.signal.throwIfAborted()
  })
  stop.mockRejectedValue(new Error('sidecar still owned'))
  await expect(
    resolveOrcadBrowserProvider({ ...options, signal: controller.signal })
  ).rejects.toThrow('orcad_browser_cleanup_failed')
  expect(chromiumStart).not.toHaveBeenCalled()
})
