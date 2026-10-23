import { clipboard, ClipboardItem } from 'electron'

export function nativeClipboardFormat(format: string): string {
  return `electron application/osclipboard;format="${format}"`
}

export async function readClipboardBuffer(
  format: string,
  assertByteLength?: (length: number) => void
): Promise<Buffer> {
  const items = await clipboard.read()
  for (const type of [format, nativeClipboardFormat(format)]) {
    const item = items.find((entry) => entry.types.includes(type))
    if (!item) {
      continue
    }
    const blob = await item.getType(type)
    if (!(blob instanceof Blob)) {
      throw new Error('Clipboard format is not binary data')
    }
    if (assertByteLength) {
      assertByteLength(blob.size)
    } else if (blob.size > 256 * 1024) {
      return Buffer.alloc(0)
    }
    return Buffer.from(await blob.arrayBuffer())
  }
  return Buffer.alloc(0)
}

export async function writeClipboardBuffer(format: string, buffer: Buffer): Promise<void> {
  await clipboard.write([
    new ClipboardItem({ [nativeClipboardFormat(format)]: new Blob([new Uint8Array(buffer)]) })
  ])
}

export async function writeClipboardPng(buffer: Buffer): Promise<void> {
  await clipboard.write([
    new ClipboardItem({
      'image/png': new Blob([new Uint8Array(buffer)], { type: 'image/png' })
    })
  ])
}

export const clipboardFormatReader = {
  readBuffer: readClipboardBuffer,
  availableFormats: async (): Promise<string[]> =>
    (await clipboard.read()).flatMap((item) => item.types),
  has: (format: string): Promise<boolean> => clipboard.has(nativeClipboardFormat(format))
}
