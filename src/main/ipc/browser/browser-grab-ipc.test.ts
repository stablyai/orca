import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(
  (): {
    guest: (EventEmitter & { id: number; isDestroyed: () => boolean }) | null
    handlers: Map<string, (event: unknown, args: unknown) => unknown>
    run: (enabled: boolean, signal: AbortSignal) => Promise<boolean>
    cancelledOps: string[]
    capture: (signal: AbortSignal) => Promise<{
      dataUrl: string
      width: number
      height: number
    } | null>
  } => ({
    guest: null,
    handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
    run: async (_enabled: boolean, _signal: AbortSignal): Promise<boolean> => true,
    cancelledOps: [],
    capture: async () => ({ dataUrl: 'data:image/png;base64,AA', width: 8, height: 8 })
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
    cancelGrabOp: (page: string) => mocks.cancelledOps.push(page),
    captureCleanPage: (_guest: unknown, signal: AbortSignal) => mocks.capture(signal),
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
import { captureCleanGuestPage } from '../../browser/element-grab/grab-clean-page-capture'

beforeEach(() => {
  resetGrabModeState()
  mocks.guest = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false })
  mocks.run = async () => true
  mocks.cancelledOps = []
  mocks.capture = async () => ({ dataUrl: 'data:image/png;base64,AA', width: 8, height: 8 })
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

const setMode = (page: string, enabled: boolean, requestId: string): Promise<unknown> =>
  Promise.resolve(
    mocks.handlers.get('browser:setGrabMode')?.(
      { sender: { id: 17 } },
      { browserPageId: page, enabled, requestId }
    )
  )
const cancelMode = (page: string, requestId: string): unknown =>
  mocks.handlers.get('browser:cancelGrab')?.(
    { sender: { id: 17 } },
    { browserPageId: page, requestId }
  )

it('a request refused at admission leaves no owner that a later cancel could match', async () => {
  mocks.run = (_enabled, signal) =>
    new Promise<boolean>((resolve) =>
      signal.addEventListener('abort', () => resolve(false), { once: true })
    )
  const held = Array.from({ length: 32 }, (_, index) =>
    setMode(`held-${index}`, false, `held-${index}`)
  )
  await expect(setMode('refused', false, 'refused')).resolves.toEqual({
    ok: false,
    reason: 'not-ready'
  })
  expect(cancelMode('refused', 'refused')).toBe(false)
  resetGrabModeState()
  await Promise.all(held)
})

it('a late cancel for a request bound to a replaced registration leaves the replacement page work alone', async () => {
  await expect(setMode('page', true, 'original')).resolves.toEqual({ ok: true, clean: false })
  mocks.guest = Object.assign(new EventEmitter(), { id: 8, isDestroyed: () => false })
  expect(cancelMode('page', 'original')).toBe(true)
  expect(mocks.cancelledOps).toEqual([])

  await expect(setMode('page', true, 'replacement')).resolves.toEqual({ ok: true, clean: false })
  expect(cancelMode('page', 'replacement')).toBe(true)
  expect(mocks.cancelledOps).toEqual(['page'])
})

it('an arm admitted while Draw captures the cleaned page waits for that capture and voids it', async () => {
  const modes: boolean[] = []
  mocks.run = async (enabled) => {
    modes.push(enabled)
    return true
  }
  let finishReadback: (() => void) | undefined
  let readbackStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    readbackStarted = resolve
  })
  const paint: string[] = []
  // The production helper over a native readback that is already in flight and cannot be cancelled.
  const readbackGuest = {
    isDestroyed: () => false,
    capturePage: () => {
      readbackStarted?.()
      return new Promise<{
        isEmpty: () => boolean
        toDataURL: () => string
        getSize: () => { width: number; height: number }
      }>((resolve) => {
        finishReadback = () =>
          resolve({
            isEmpty: () => false,
            toDataURL: () => 'data:image/png;base64,AA',
            getSize: () => ({ width: 8, height: 8 })
          })
      })
    }
  }
  mocks.capture = (signal) =>
    captureCleanGuestPage(readbackGuest, signal, () => {
      paint.push('hold')
      return () => paint.push('release')
    })
  const capture = Promise.resolve(
    mocks.handlers.get('browser:captureCleanPage')?.(
      { sender: { id: 17 } },
      { browserPageId: 'page', requestId: 'draw' }
    )
  )
  await started
  // Admitting the arm aborts the capture; native readback is still pending.
  const arm = setMode('page', true, 'rearm')
  for (let turn = 0; turn < 5; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  expect(modes).toEqual([false])
  expect(paint).toEqual(['hold'])

  finishReadback?.()
  await expect(capture).resolves.toBeNull()
  await expect(arm).resolves.toEqual({ ok: true, clean: false })
  expect(modes).toEqual([false, true])
  expect(paint).toEqual(['hold', 'release'])
})

it('hands Draw the capture of the document its own request cleaned', async () => {
  await expect(
    mocks.handlers.get('browser:captureCleanPage')?.(
      { sender: { id: 17 } },
      { browserPageId: 'page', requestId: 'draw' }
    )
  ).resolves.toEqual({ dataUrl: 'data:image/png;base64,AA', width: 8, height: 8 })
})
