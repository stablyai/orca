import { expect, it } from 'vitest'
import { emulatorDisplayCoordinates } from './emulator-display-coordinates'

it('undoes a landscape screenshot rotation before injecting into the physical display', () => {
  expect(emulatorDisplayCoordinates(0.25, 0.75, 1, { width: 1080, height: 2400 })).toEqual({
    x: 270,
    y: 600
  })
  expect(emulatorDisplayCoordinates(0.25, 0.75, 3, { width: 1080, height: 2400 })).toEqual({
    x: 810,
    y: 1800
  })
})

it('keeps rotated edge touches inside the last addressable display pixel', () => {
  expect(emulatorDisplayCoordinates(0, 0, 2, { width: 1080, height: 2400 })).toEqual({
    x: 1079,
    y: 2399
  })
})
