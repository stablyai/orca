import { clipboard, ClipboardItem } from 'electron'

export function nativeClipboardFormat(format: string): string {
  return `electron application/osclipboard;format="${format}"`
}

type ClipboardItems = Awaited<ReturnType<typeof clipboard.read>>

async function readItemsBuffer(
  items: ClipboardItems,
  format: string,
  assertByteLength?: (length: number) => void
): Promise<Buffer> {
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

export type ClipboardFormatReader = {
  availableFormats: () => Promise<string[]>
  readBuffer: (format: string, assertByteLength?: (length: number) => void) => Promise<Buffer>
  has: (format: string) => Promise<boolean>
  readHtml: () => Promise<string>
}

/** Reads the clipboard at most once per request: each read() re-enumerates every native format. */
export function clipboardFormatSnapshot(): ClipboardFormatReader {
  let items: Promise<ClipboardItems> | null = null
  const read = (): Promise<ClipboardItems> => (items ??= clipboard.read())
  // getType() fetches from the pasteboard each call; a paste probes the same file-list formats twice.
  const unboundedReads = new Map<string, Promise<Buffer>>()
  return {
    availableFormats: async () => (await read()).flatMap((item) => item.types),
    readBuffer: async (format, assertByteLength) => {
      if (assertByteLength) {
        return readItemsBuffer(await read(), format, assertByteLength)
      }
      let buffer = unboundedReads.get(format)
      if (!buffer) {
        buffer = read().then((entries) => readItemsBuffer(entries, format))
        unboundedReads.set(format, buffer)
      }
      return buffer
    },
    // Electron's has() is membership in this same type list, enumerated again.
    has: async (format) =>
      (await read()).some((item) => item.types.includes(nativeClipboardFormat(format))),
    readHtml: async () => {
      const item = (await read()).find((entry) => entry.types.includes('text/html'))
      return item ? (await item.getType('text/html')).text() : ''
    }
  }
}
