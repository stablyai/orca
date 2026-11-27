import { beforeEach, expect, it, vi } from 'vitest'

const RECT = { x: 0, y: 0, width: 4, height: 4, viewportWidth: 8 }
// Whether the picked element is still live where it was prepared; a test retires it mid-wait.
const pick = vi.hoisted(() => ({ live: true }))
vi.mock('./grab-guest-execution', () => ({
  grabDocumentScope: () => ({ current: true }),
  restoreGrabCapture: () => {},
  requestGrabExecution: async (
    _guest: unknown,
    _code: string,
    options: { pick?: { operation: string } }
  ) =>
    options.pick?.operation === 'prepareCapture' || pick.live
      ? { ok: true, value: RECT }
      : { ok: true, value: null }
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
  pick.live = true
})

it('a pick retired while its screenshot waits for the lane submits no readback; the next capture runs', async () => {
  const { guest, readbacks, releaseLane } = heldLaneGuest()
  const selection = captureSelectionScreenshot(RECT, guest, 'sel', () => () => {})
  await flush()
  // The pick is cancelled in the page while its screenshot waits behind another capture.
  pick.live = false
  const draw = captureCleanDocumentPage(
    guest,
    new AbortController().signal,
    () => () => {},
    () => true
  )
  releaseLane()
  await flush()
  // The stale screenshot ends without a readback; one still running would leave it pending here.
  await expect(
    Promise.race([selection, flush().then(() => 'stale screenshot still reading back')])
  ).resolves.toBeNull()
  expect(readbacks).toHaveLength(1)
  readbacks[0]()
  await expect(draw).resolves.toEqual({ dataUrl: 'data:image/png;base64,AA', width: 8, height: 8 })
  // Only Draw's readback ever reached the native lane.
  expect(readbacks).toHaveLength(1)
})

it('a pick still live after the wait is captured once the lane frees', async () => {
  const { guest, readbacks, releaseLane } = heldLaneGuest()
  const selection = captureSelectionScreenshot(RECT, guest, 'sel', () => () => {})
  await flush()
  const draw = captureCleanDocumentPage(
    guest,
    new AbortController().signal,
    () => () => {},
    () => true
  )
  releaseLane()
  // Settle each readback as it reaches the lane, in whichever order the two captures submit.
  for (const index of [0, 1]) {
    await vi.waitFor(() => expect(readbacks.length).toBeGreaterThan(index))
    readbacks[index]()
  }
  await expect(draw).resolves.not.toBeNull()
  await expect(selection).resolves.toMatchObject({ mimeType: 'image/png', width: 4, height: 4 })
})

it("a Draw started while Grab's selection readback is in flight submits only once that readback settles", async () => {
  const { guest, readbacks, releaseLane } = heldLaneGuest()
  releaseLane()
  await flush()
  const selection = captureSelectionScreenshot(RECT, guest, 'sel', () => () => {})
  await vi.waitFor(() => expect(readbacks).toHaveLength(1))
  // Grab is left and Draw starts on the same guest while the selection's readback is still native.
  const draw = captureCleanDocumentPage(
    guest,
    new AbortController().signal,
    () => () => {},
    () => true
  )
  await flush()
  expect(readbacks).toHaveLength(1)
  readbacks[0]()
  await expect(selection).resolves.not.toBeNull()
  await vi.waitFor(() => expect(readbacks).toHaveLength(2))
  readbacks[1]()
  await expect(draw).resolves.toEqual({ dataUrl: 'data:image/png;base64,AA', width: 8, height: 8 })
})
