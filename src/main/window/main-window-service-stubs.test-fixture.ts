import { vi } from 'vitest'
import type { RuntimeNotifier } from '../runtime/runtime-notifier-contract'

type MockFn = ReturnType<typeof vi.fn>

export type MainWindowStub = {
  id?: number
  isDestroyed?: MockFn
  on: MockFn
  once: MockFn
  webContents: {
    id?: number
    getURL: MockFn
    isDestroyed?: MockFn
    isLoadingMainFrame: MockFn
    on: MockFn
    send?: MockFn
    reload?: MockFn
    session: {
      setPermissionRequestHandler: MockFn
      setPermissionCheckHandler: MockFn
    }
  }
}

type RuntimeStub = {
  attachWindow: MockFn
  setNotifier: ReturnType<typeof vi.fn<(notifier: RuntimeNotifier | null) => void>>
  markRendererReloading: MockFn
  markRendererReloadCancelled: MockFn
  markGraphReloadFailed: MockFn
  markGraphUnavailable: MockFn
}

export function createMainWindowServiceStub(
  permissionHandlers: {
    setPermissionRequestHandler: MockFn
    setPermissionCheckHandler: MockFn
  },
  extraWebContents: { isLoadingMainFrame?: MockFn; on?: MockFn; send?: MockFn } = {}
): MainWindowStub {
  return {
    id: 1,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    webContents: {
      id: 1,
      getURL: vi.fn(() => 'file:///opt/orca/renderer/index.html'),
      isDestroyed: vi.fn(() => false),
      isLoadingMainFrame: vi.fn(() => true),
      on: vi.fn(),
      reload: vi.fn(),
      session: {
        setPermissionRequestHandler: permissionHandlers.setPermissionRequestHandler,
        setPermissionCheckHandler: permissionHandlers.setPermissionCheckHandler
      },
      ...extraWebContents
    }
  }
}

export function createRuntime(): RuntimeStub {
  return {
    attachWindow: vi.fn(),
    setNotifier: vi.fn<(notifier: RuntimeNotifier | null) => void>(),
    markRendererReloading: vi.fn(),
    markRendererReloadCancelled: vi.fn(),
    markGraphReloadFailed: vi.fn(),
    markGraphUnavailable: vi.fn()
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}
