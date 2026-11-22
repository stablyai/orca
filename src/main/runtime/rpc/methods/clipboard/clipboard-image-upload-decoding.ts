/** Decode individually validated upload chunks without a second image-sized base64 string. */
export function decodeClipboardImageUpload(chunks: readonly string[]): Buffer {
  let characters = 0
  let padding = 0
  for (const chunk of chunks) {
    const paddingOffset = chunk.indexOf('=')
    const dataCharacters = paddingOffset === -1 ? chunk.length : paddingOffset
    if (padding > 0 && dataCharacters > 0) {
      throw new Error('Clipboard image content must be base64')
    }
    padding += chunk.length - dataCharacters
    characters += chunk.length
  }
  if (characters % 4 === 1 || padding > 2) {
    throw new Error('Clipboard image content must be base64')
  }

  const bytes = Buffer.allocUnsafe(Math.floor(((characters - padding) * 3) / 4))
  let offset = 0
  let carry = ''
  for (const chunk of chunks) {
    const text = carry ? carry + chunk : chunk
    const completeLength = text.length - (text.length % 4)
    if (completeLength > 0) {
      offset += bytes.write(text.slice(0, completeLength), offset, bytes.length - offset, 'base64')
    }
    carry = text.slice(completeLength)
  }
  if (carry) {
    bytes.write(carry, offset, bytes.length - offset, 'base64')
  }
  return bytes
}
