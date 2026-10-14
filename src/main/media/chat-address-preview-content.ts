import { extname } from 'node:path'
import type { ChatAddressPreviewKind } from '../../shared/chat-address-preview'
import { isBinaryBuffer } from '../../shared/binary-buffer'

export const CHAT_PREVIEW_PROBE_BYTES = 4096
export const CHAT_PREVIEW_MAX_TEXT_BYTES = 1024 * 1024
export const CHAT_PREVIEW_MAX_PDF_BYTES = 10 * 1024 * 1024
export const CHAT_PREVIEW_MAX_IMAGE_BYTES = 16 * 1024 * 1024
export type PreviewContentType = { kind: ChatAddressPreviewKind; mimeType: string }

export function inspectPreviewContent(
  bytes: Buffer,
  name: string,
  responseMime?: string
): PreviewContentType {
  const mime = responseMime?.split(';', 1)[0].trim().toLowerCase()
  const ascii = (start: number, end: number): string => bytes.toString('latin1', start, end)
  const typed = (kind: ChatAddressPreviewKind, mimeType: string): PreviewContentType => ({
    kind,
    mimeType
  })
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return typed('image', 'image/png')
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return typed('image', 'image/jpeg')
  }
  if (/^GIF8[79]a$/.test(ascii(0, 6))) {
    return typed('image', 'image/gif')
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return typed('image', 'image/webp')
  }
  if (ascii(0, 2) === 'BM') {
    return typed('image', 'image/bmp')
  }
  if (bytes.length >= 6 && bytes.readUInt32LE(0) === 0x00010000) {
    return typed('image', 'image/x-icon')
  }
  if (ascii(0, 5) === '%PDF-') {
    return typed('pdf', 'application/pdf')
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') {
    return typed('audio', 'audio/wav')
  }
  if (ascii(0, 4) === 'fLaC') {
    return typed('audio', 'audio/flac')
  }
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
    const aac = bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0
    return typed('audio', aac ? 'audio/aac' : 'audio/mpeg')
  }
  if (ascii(0, 4) === 'OggS') {
    return ascii(0, bytes.length).includes('theora')
      ? typed('video', 'video/ogg')
      : typed('audio', 'audio/ogg')
  }
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    if (['avif', 'avis', 'heic', 'heix', 'mif1'].includes(brand)) {
      return typed('file', 'application/octet-stream')
    }
    return brand === 'M4A ' || mime === 'audio/mp4' || extname(name).toLowerCase() === '.m4a'
      ? typed('audio', 'audio/mp4')
      : typed('video', brand === 'qt  ' ? 'video/quicktime' : 'video/mp4')
  }
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) {
    return mime === 'audio/webm' ? typed('audio', 'audio/webm') : typed('video', 'video/webm')
  }
  if (isBinaryBuffer(bytes)) {
    return typed('file', 'application/octet-stream')
  }
  try {
    // Streaming mode allows a UTF-8 codepoint cut by the bounded prefix.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
  } catch {
    return typed('file', 'application/octet-stream')
  }
  const text = bytes
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
  if (/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) {
    return typed('image', 'image/svg+xml')
  }
  // HTML, scripts and XML remain inert text; extension/MIME never grants document execution.
  if (/\.(md|markdown|mdown)$/i.test(name) || mime === 'text/markdown') {
    return typed('markdown', 'text/markdown')
  }
  return typed('text', 'text/plain')
}

export function previewContentLimit(kind: ChatAddressPreviewKind): number {
  if (kind === 'image') {
    return CHAT_PREVIEW_MAX_IMAGE_BYTES
  }
  if (kind === 'pdf') {
    return CHAT_PREVIEW_MAX_PDF_BYTES
  }
  return CHAT_PREVIEW_MAX_TEXT_BYTES
}
