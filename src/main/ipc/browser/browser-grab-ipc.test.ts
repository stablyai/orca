import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(
  (): {
    guest: (EventEmitter & { id: number; isDestroyed: () => boolean }) | null
    handlers: Map<string, (event: unknown, args: unknown) => unknown>
    run: (enabled: boolean, signal: AbortSignal) => Promise<boolean>
  } => ({
    guest: null,
    handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
    run: async (_enabled: boolean, _signal: AbortSignal): Promise<boolean> => true
  })
)
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
    getAuthorizedGuest: () => mocks.guest,
    cancelGrabOp: () => {},
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
  mocks.guest = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false })
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
  await expect(latest).resolves.toMatchObject({ ok: true, clean: true })
  expect(enabled).toBe(false)
})

it('cancels only the matching pending mode request, leaving its successor usable', async () => {
  let enter: (() => void) | undefined
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  mocks.run = async (_enabled, signal) => {
    enter?.()
    return new Promise<boolean>((resolve) =>
      signal.addEventListener('abort', () => resolve(false), { once: true })
    )
  }
  const sender = { id: 17 }
  const mode = (requestId: string) =>
    Promise.resolve(
      mocks.handlers.get('browser:setGrabMode')?.(
        { sender },
        { browserPageId: 'page', enabled: false, requestId }
      )
    )
  const cancel = (requestId: string) =>
    mocks.handlers.get('browser:cancelGrab')?.({ sender }, { browserPageId: 'page', requestId })
  const pending = mode('pending')
  await entered
  expect(cancel('obsolete')).toBe(false)
  expect(cancel('pending')).toBe(true)
  await expect(pending).resolves.toEqual({ ok: false, reason: 'not-ready' })
  mocks.run = async () => true
  await expect(mode('successor')).resolves.toEqual({ ok: true, clean: true })
  expect(cancel('pending')).toBe(false)
})

it('distinguishes missing-guest cleanup from a positive clean capture permit', async () => {
  mocks.guest = null
  const result = mocks.handlers.get('browser:setGrabMode')?.(
    { sender: { id: 17 } },
    { browserPageId: 'gone', enabled: false, requestId: 'cleanup' }
  )
  await expect(result).resolves.toEqual({ ok: true, clean: false })
})
