import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  lookup: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../npm-package-info/npm-package-info-service', () => ({
  createNpmPackageInfoService: () => ({ lookup: mocks.lookup })
}))

const { registerNpmPackageInfoHandlers } = await import('./npm-package-info-ipc')
const { NPM_PACKAGE_INFO_LOOKUP_CHANNEL } = await import('../../shared/npm-package-info-types')

const fakeStore = {} as Store
const fakeEvent = {}

function invoke(request: unknown) {
  const handler = mocks.handlers.get(NPM_PACKAGE_INFO_LOOKUP_CHANNEL)
  if (!handler) {
    throw new Error('npmPackageInfo:lookup handler was not registered')
  }
  return handler(fakeEvent, request)
}

describe('registerNpmPackageInfoHandlers', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.lookup.mockReset()
  })

  it('forwards a well-formed request to the service and returns its exact result', async () => {
    mocks.lookup.mockResolvedValue({ status: 'lookup-disabled' })
    registerNpmPackageInfoHandlers(fakeStore)

    const request = { packageName: 'react', worktreeRoot: '/repo', executionHostId: 'local' }
    const result = await invoke(request)

    expect(mocks.lookup).toHaveBeenCalledWith(request)
    expect(result).toEqual({ status: 'lookup-disabled' })
  })

  it('never throws for an invalid package name; returns unavailable without calling the service', async () => {
    registerNpmPackageInfoHandlers(fakeStore)

    const result = await invoke({
      packageName: '-evil-flag',
      executionHostId: 'local'
    })

    expect(result).toEqual({ status: 'unavailable', reason: 'error' })
    expect(mocks.lookup).not.toHaveBeenCalled()
  })

  it('never throws for a malformed request shape', async () => {
    registerNpmPackageInfoHandlers(fakeStore)

    const result = await invoke({ packageName: 42 })

    expect(result).toEqual({ status: 'unavailable', reason: 'error' })
    expect(mocks.lookup).not.toHaveBeenCalled()
  })

  it('never throws when the service itself rejects', async () => {
    mocks.lookup.mockRejectedValue(new Error('boom'))
    registerNpmPackageInfoHandlers(fakeStore)

    const result = await invoke({
      packageName: 'react',
      executionHostId: 'local'
    })

    expect(result).toEqual({ status: 'unavailable', reason: 'error' })
  })
})
