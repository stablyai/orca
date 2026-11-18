import { expect, it } from 'vitest'
import { clampGrabPayload } from './browser-grab-payload'

it.each([
  ['https://kagi.com/search?token=title-secret&q=one', 'https://kagi.com/search?q=one'],
  ['https://example.com/?token=ordinary', 'https://example.com/?token=ordinary']
])('sanitizes URL-valued annotation titles at the receiving boundary: %s', (title, safe) => {
  const result = clampGrabPayload({
    page: { title, sanitizedUrl: title },
    target: { tagName: 'button' }
  })
  expect(result?.page.title).toBe(safe)
})
