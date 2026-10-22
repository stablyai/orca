import { readFile } from 'node:fs/promises'
import type { MspTurnInputPart } from './msp-protocol'

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

export function mediaTypeForImagePath(path: string): string | null {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot === -1) {
    return null
  }
  return IMAGE_MEDIA_TYPES[lower.slice(dot)] ?? null
}

export type MspTextInput = { text: string }
export type MspImageInput = { path: string }
export type MspDispatchInput = (MspTextInput | MspImageInput)[]

export async function mspTurnParts(input: MspDispatchInput): Promise<MspTurnInputPart[]> {
  const parts: MspTurnInputPart[] = []
  for (const entry of input) {
    if ('text' in entry) {
      parts.push({ type: 'text', text: entry.text })
      continue
    }
    const mediaType = mediaTypeForImagePath(entry.path)
    if (!mediaType) {
      throw new Error(`Muse structured chat cannot send ${entry.path}: not a supported image`)
    }
    const bytes = await readFile(entry.path)
    parts.push({ type: 'image', base64Data: bytes.toString('base64'), mediaType })
  }
  return parts
}
