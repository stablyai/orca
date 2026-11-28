import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as GuestExecution from './grab-guest-execution'

const RECT = { x: 0, y: 0, width: 4, height: 4, viewportWidth: 8 }
// The page's answers about the pick; a test can hold the final one in transit.
const reports = vi.hoisted((): { hold: boolean; deliver: (() => void)[] } => ({
  hold: false,
  deliver: []
}))
vi.mock('../guest-lifecycle/manager/browser-manager', () => ({
  browserManager: { setGrabMode: async () => true, cancelGrabOp: () => {} }
}))
// Real document scopes and overlay retirement; only the page's execution answers are scripted.
vi.mock('./grab-guest-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof GuestExecution>()
  return {
    ...actual,
    requestGrabExecution: (
      _guest: unknown,
      _code: string,
      options: { pick?: { operation: string } }
    ) => {
      const answer = { ok: true as const, value: RECT }
      if (options.pick?.operation === 'snapshot' && reports.hold) {
        return new Promise((resolve) => reports.deliver.push(() => resolve(answer)))
      }
      return Promise.resolve(answer)
    }
  }
})

import { captureSelectionScreenshot } from './browser-grab-screenshot'
import { grabDocumentScope } from './grab-guest-execution'
import {
  cancelBrowserGrabMode,
  resetGrabModeState,
  setBrowserGrabMode
} from './browser-grab-mode-sequencer'

const image = {
  isEmpty: () => false,
  getSize: () => ({ width: 8, height: 8 }),
  crop: () => ({ toPNG: () => Buffer.from('png') })
}

/** A guest whose picker main armed for request `r`, with its native readbacks counted. */
async function armedGuest() {
  const readbacks = { count: 0 }
  const guest = Object.assign(new EventEmitter(), {
    id: 41,
    isDestroyed: () => false,
    capturePage: async () => {
      readbacks.count++
      return image
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sequencer, scope and capture read only id, isDestroyed, capturePage and events.
  const webContents = guest as unknown as Electron.WebContents
  const resolveGuest = (): Electron.WebContents => webContents
  await expect(
    setBrowserGrabMode('page', true, resolveGuest, undefined, {
      requestId: 'r',
      owner: 'renderer:1'
    })
  ).resolves.toEqual({ ok: true, clean: false })
  // The page reported a successful arm: main records the live picker on this document.
  const scope = grabDocumentScope(webContents)
  scope.documentId = 'doc-1'
  scope.overlayId = 'picker-1'
  return { guest: webContents, resolveGuest, readbacks, scope }
}

beforeEach(() => {
  reports.hold = false
  reports.deliver = []
})
afterEach(() => resetGrabModeState())

it('a picker main cancels while the final page report is in transit yields no screenshot bytes', async () => {
  const { guest, resolveGuest, readbacks, scope } = await armedGuest()
  reports.hold = true
  const shot = captureSelectionScreenshot(RECT, guest, 'sel', () => () => {})
  await vi.waitFor(() => expect(reports.deliver).toHaveLength(1))
  // The readback already ran; only the final check against the page is outstanding.
  expect(readbacks.count).toBe(1)

  // Main handles the exact cancel for this request on the same, still-current document.
  expect(cancelBrowserGrabMode('page', resolveGuest, 'r', 'renderer:1')).toBe(true)
  expect(scope.current).toBe(true)
  expect(scope.overlayId).toBeNull()

  reports.deliver[0]()
  await expect(shot).resolves.toBeNull()
})

it('a picker still live when the final page report arrives yields the screenshot', async () => {
  const { guest } = await armedGuest()
  reports.hold = true
  const shot = captureSelectionScreenshot(RECT, guest, 'sel', () => () => {})
  await vi.waitFor(() => expect(reports.deliver).toHaveLength(1))
  reports.deliver[0]()
  await expect(shot).resolves.toMatchObject({ mimeType: 'image/png', width: 4, height: 4 })
})
