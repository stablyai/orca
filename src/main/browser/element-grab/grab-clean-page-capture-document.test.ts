import { expect, it } from 'vitest'
import { captureCleanDocumentPage } from './grab-clean-page-capture'
import { occupyNativeCaptureLane } from '../../window/visibility/native-capture-lane'

const image = {
  isEmpty: () => false,
  toDataURL: () => 'data:image/png;base64,AA',
  getSize: () => ({ width: 8, height: 8 })
}

it('a Draw readback waiting for the lane does not submit once the page moved to another document', async () => {
  let readbacks = 0
  const guest = {
    isDestroyed: () => false,
    capturePage: async () => {
      readbacks++
      return image
    }
  }
  let freeLane: () => void = () => {}
  occupyNativeCaptureLane(
    guest,
    new Promise<void>((resolve) => {
      freeLane = resolve
    })
  )
  let sameDocument = true
  const draw = captureCleanDocumentPage(
    guest,
    new AbortController().signal,
    () => () => {},
    () => sameDocument
  )
  // The page navigates while Draw waits for the capture already in flight.
  sameDocument = false
  freeLane()
  await expect(draw).resolves.toBeNull()
  expect(readbacks).toBe(0)
})

it('a Draw readback on the same document still submits when the lane frees', async () => {
  let readbacks = 0
  const guest = {
    isDestroyed: () => false,
    capturePage: async () => {
      readbacks++
      return image
    }
  }
  await expect(
    captureCleanDocumentPage(
      guest,
      new AbortController().signal,
      () => () => {},
      () => true
    )
  ).resolves.toEqual({ dataUrl: 'data:image/png;base64,AA', width: 8, height: 8 })
  expect(readbacks).toBe(1)
})
