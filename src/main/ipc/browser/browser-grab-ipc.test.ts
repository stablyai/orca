import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  run: async (_enabled: boolean, _signal: AbortSignal): Promise<boolean> => true
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, args: unknown) => unknown) =>
      mocks.handlers.set(name, handler),
    removeHandler: (name: string) => mocks.handlers.delete(name)
  },
  webContents: { fromId: () => null }
}))
vi.mock('../../browser/guest-lifecycle/manager/browser-manager', () => ({
  browserManager: {
    getAuthorizedGuest: () => ({ id: 7 }),
    setGrabMode: (
      _page: string,
      enabled: boolean,
      _guest: unknown,
      _host: unknown,
      _authorize: unknown,
      signal: AbortSignal
    ) => mocks.run(enabled, signal)
  }
}))
vi.mock('./browser-renderer-trust', () => ({ isTrustedBrowserRenderer: () => true }))

import { registerBrowserGrabHandlers, resetGrabModeState } from './browser-grab-ipc'

beforeEach(() => {
  resetGrabModeState()
  mocks.handlers.clear()
  registerBrowserGrabHandlers()
})
afterEach(() => resetGrabModeState())

it('reports superseded mode requests truthfully and completes the latest requested mode', async () => {
  let enter: (() => void) | undefined
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let release: (() => void) | undefined
  const firstNative = new Promise<void>((resolve) => {
    release = resolve
  })
  let enabled = false
  mocks.run = async (next) => {
    if (next) {
      enter?.()
      await firstNative
    }
    enabled = next
    return true
  }
  const change = (next: boolean): Promise<unknown> =>
    Promise.resolve(
      mocks.handlers.get('browser:setGrabMode')?.(
        { sender: { id: 17 } },
        { browserPageId: 'page', enabled: next }
      )
    )
  const first = change(true)
  await entered
  const superseded = change(true)
  const latest = change(false)
  await expect(superseded).resolves.toEqual({ ok: false, reason: 'not-ready' })
  release?.()
  await expect(first).resolves.toEqual({ ok: false, reason: 'not-ready' })
  await expect(latest).resolves.toEqual({ ok: true })
  expect(enabled).toBe(false)
})
