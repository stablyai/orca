import { beforeEach, expect, it, vi } from 'vitest'

const RECT = { x: 0, y: 0, width: 4, height: 4, viewportWidth: 8 }
// Main's document scope for the guest: the picker main knows is live, on a current document.
const scope = vi.hoisted((): { current: boolean; overlayId: string | null } => ({
  current: true,
  overlayId: 'picker-1'
}))
// The page's answers to "is the pick still where it was?"; a test can hold one in transit.
const reports = vi.hoisted((): { hold: boolean; deliver: (() => void)[] } => ({
  hold: false,
  deliver: []
}))
vi.mock('./grab-guest-execution', () => ({
  grabDocumentScope: () => scope,
  restoreGrabCapture: () => {},
  requestGrabExecution: (
    _guest: unknown,
    _code: string,
    options: { pick?: { operation: string } }
  ) => {
    const answer = { ok: true, value: RECT }
    if (options.pick?.operation === 'snapshot' && reports.hold) {
      return new Promise((resolve) => reports.deliver.push(() => resolve(answer)))
    }
    return Promise.resolve(answer)
  }
}))

import { captureSelectionScreenshot } from './browser-grab-screenshot'
import { captureCleanDocumentPage } from './grab-clean-page-capture'
import { occupyNativeCaptureLane } from '../../window/visibility/native-capture-lane'

const image = {
  isEmpty: () => false,
  getSize: () => ({ width: 8, height: 8 }),
  crop: () => ({ toPNG: () => Buffer.from('png') }),
  toDataURL: () => 'data:image/png;base64,AA'
}
const flush = async (turns = 20): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve()
  }
}

/** A guest whose native readbacks settle only when the test says, with the lane held by another. */
function heldLaneGuest() {
  const readbacks: (() => void)[] = []
  const guest = {
    isDestroyed: () => false,
    capturePage: () =>
      new Promise<typeof image>((resolve) => {
        readbacks.push(() => resolve(image))
      })
  }
  let releaseLane: () => void = () => {}
  occupyNativeCaptureLane(
    guest,
    new Promise<void>((resolve) => {
      releaseLane = resolve
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the captures read only isDestroyed and capturePage.
  return { guest: guest as unknown as Electron.WebContents, readbacks, releaseLane }
}

beforeEach(() => {
  scope.current = true
  scope.overlayId = 'picker-1'
  reports.hold = false
  reports.deliver = []
})

/** Waits until the screenshot has asked the page about its pick after the lane freed. */
async function screenshotHoldingItsReport() {
  const lane = heldLaneGuest()
  const selection = captureSelectionScreenshot(RECT, lane.guest, 'sel', () => () => {})
  await flush()
  reports.hold = true
  lane.releaseLane()
  await vi.waitFor(() => expect(reports.deliver).toHaveLength(1))
  return { ...lane, selection }
}

it('a pick main retired while the page’s positive report was in transit submits no readback', async () => {
  const { guest, readbacks, selection } = await screenshotHoldingItsReport()
  // Main handles the same-document cancel first: the picker is retired, the document stays current.
  scope.overlayId = null
  reports.deliver[0]()
  await flush()
  expect(readbacks).toHaveLength(0)
  await expect(selection).resolves.toBeNull()

  // A Draw after the cancel gets the lane at once and succeeds.
  scope.overlayId = 'picker-2'
  const draw = captureCleanDocumentPage(
    guest,
    new AbortController().signal,
    () => () => {},
    () => true
  )
  await vi.waitFor(() => expect(readbacks).toHaveLength(1))
  readbacks[0]()
  await expect(draw).resolves.toEqual({ dataUrl: 'data:image/png;base64,AA', width: 8, height: 8 })
})

it('a picker still owned when the report arrives is captured', async () => {
  const { readbacks, selection } = await screenshotHoldingItsReport()
  // Later page reports (the check after the readback) answer at once.
  reports.hold = false
  reports.deliver[0]()
  await vi.waitFor(() => expect(readbacks).toHaveLength(1))
  readbacks[0]()
  await expect(selection).resolves.toMatchObject({ mimeType: 'image/png', width: 4, height: 4 })
})
