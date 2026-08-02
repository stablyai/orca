export const MOBILE_NATIVE_CHAT_TEXT_CHUNK_CHARS = 4000

export type MobileNativeChatTextChunk = { start: number; text: string }

export function splitMobileNativeChatLongText(text: string): MobileNativeChatTextChunk[] {
  const chunks: MobileNativeChatTextChunk[] = []
  let start = 0
  while (start < text.length) {
    const hardEnd = Math.min(start + MOBILE_NATIVE_CHAT_TEXT_CHUNK_CHARS, text.length)
    let end = safeCodePointBoundary(text, hardEnd)
    if (hardEnd < text.length) {
      end = preferredTextBoundary(text, start, end)
    }
    chunks.push({ start, text: text.slice(start, end) })
    start = end
  }
  return chunks
}

function safeCodePointBoundary(text: string, end: number): number {
  const previous = text.charCodeAt(end - 1)
  const next = text.charCodeAt(end)
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? end - 1
    : end
}

function preferredTextBoundary(text: string, start: number, hardEnd: number): number {
  const minimum = start + Math.floor(MOBILE_NATIVE_CHAT_TEXT_CHUNK_CHARS * 0.75)
  for (let index = hardEnd - 1; index >= minimum; index--) {
    if (text.charCodeAt(index) === 10) {
      return index + 1
    }
  }
  for (let index = hardEnd - 1; index >= minimum; index--) {
    if (text.charCodeAt(index) === 32) {
      return index + 1
    }
  }
  return hardEnd
}
