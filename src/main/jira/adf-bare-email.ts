type EmailSpan = { start: number; end: number; url: string }

// The narrow read seam measures real scanner work without changing its traversal.
export const emailCharacterReader = { read: (value: string, index: number): string => value[index] }
const LOCAL = /^[a-zA-Z0-9.!#$%&'*+/=?^_{|}~-]$/
const DOMAIN = /^[a-zA-Z0-9-]$/

export function bareEmailSpans(value: string): EmailSpan[] {
  const spans: EmailSpan[] = []
  let acceptedEnd = 0
  for (let at = 0; at < value.length; at++) {
    if (emailCharacterReader.read(value, at) !== '@') {
      continue
    }
    let start = at
    while (start > 0) {
      const char = emailCharacterReader.read(value, start - 1)
      if (!LOCAL.test(char)) {
        break
      }
      start--
    }
    let labelLength = 0
    let labels = 0
    let end = at + 1
    let validEnd = end
    while (end < value.length) {
      const char = emailCharacterReader.read(value, end)
      if (DOMAIN.test(char)) {
        labelLength++
        if (labels > 0) {
          validEnd = end + 1
        }
      } else if (char === '.' && labelLength > 0) {
        labels++
        labelLength = 0
      } else {
        break
      }
      end++
    }
    if (start < at && start >= acceptedEnd && validEnd > at + 1) {
      spans.push({ start, end: validEnd, url: `mailto:${value.slice(start, validEnd)}` })
      acceptedEnd = validEnd
    }
  }
  return spans
}
