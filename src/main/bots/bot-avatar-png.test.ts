import { expect, it } from 'vitest'
import { isCompleteBotAvatarPng } from './bot-avatar-png'

// A 512px, 1-bit Adam7 image. All three PNGs have valid chunk lengths and checksums.
it('requires exactly the scanlines promised by the header, including interlaced passes', async () => {
  const complete = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIAAQAAAAGrBNnBAAAAOElEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4NcAg8AAAYB1bf0AAAAASUVORK5CYII=',
    'base64'
  )
  const short = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIAAQAAAAGrBNnBAAAAOElEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4NYAg78AARSEkTUAAAAASUVORK5CYII=',
    'base64'
  )
  const overlong = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIAAQAAAAGrBNnBAAAAOElEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4NgAg8EAAXDhtR8AAAAASUVORK5CYII=',
    'base64'
  )
  expect(await isCompleteBotAvatarPng(complete)).toBe(true)
  expect(await isCompleteBotAvatarPng(short)).toBe(false)
  expect(await isCompleteBotAvatarPng(overlong)).toBe(false)
  expect(await isCompleteBotAvatarPng(complete.subarray(0, 33))).toBe(false)
})
