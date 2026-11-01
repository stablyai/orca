import {
  mobileComposerImagePasteDecision,
  mobileComposerImagePasteFileKind,
  mobileComposerImagePastePromptText,
  type MobileComposerImagePasteDecision,
  type MobileComposerPastedImage
} from './mobile-native-chat-composer-image-paste'

function isSupportedPasteImage(mime: string): boolean {
  return mobileComposerImagePasteFileKind(mime) === 'image'
}

export type ClaimedMobileComposerImagePaste =
  | {
      readonly kind: 'files'
      readonly files: readonly File[]
      readonly promptText: string
    }
  | { readonly kind: 'native' }

function snapshotFrom(data: DataTransfer | null): {
  imageFileCount: number
  otherFileCount: number
  textPlain: string
  textUriList: string
  textHtml: string
} {
  let imageFileCount = 0
  let otherFileCount = 0
  const files = data ? Array.from(data.files) : []
  if (files.length > 0) {
    for (const file of files) {
      if (isSupportedPasteImage(file.type)) {
        imageFileCount += 1
      } else {
        otherFileCount += 1
      }
    }
  } else if (data) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') {
        continue
      }
      if (isSupportedPasteImage(item.type)) {
        imageFileCount += 1
      } else {
        otherFileCount += 1
      }
    }
  }
  return {
    imageFileCount,
    otherFileCount,
    textPlain: data?.getData('text/plain') ?? '',
    textUriList: data?.getData('text/uri-list') ?? '',
    textHtml: data?.getData('text/html') ?? ''
  }
}

function imageFiles(data: DataTransfer | null): File[] {
  if (!data) {
    return []
  }
  const listed = Array.from(data.files).filter((file) => isSupportedPasteImage(file.type))
  if (listed.length > 0) {
    return listed
  }
  const fromItems: File[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !isSupportedPasteImage(item.type)) {
      continue
    }
    const file = item.getAsFile()
    if (file) {
      fromItems.push(file)
    }
  }
  return fromItems
}

// Read files synchronously: getAsFile is only valid during the paste event.
export function claimMobileComposerImagePaste(
  data: DataTransfer | null
): ClaimedMobileComposerImagePaste | null {
  const decision: MobileComposerImagePasteDecision | null = mobileComposerImagePasteDecision(
    snapshotFrom(data)
  )
  if (decision === 'files') {
    const files = imageFiles(data)
    if (files.length === 0) {
      return null
    }
    return {
      kind: 'files',
      files,
      promptText: mobileComposerImagePastePromptText(
        data?.getData('text/plain') ?? '',
        files.map((file) => file.name)
      )
    }
  }
  if (decision === 'native') {
    return { kind: 'native' }
  }
  return null
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const slice = bytes.subarray(offset, offset + chunk)
    let part = ''
    for (let index = 0; index < slice.length; index += 1) {
      part += String.fromCharCode(slice[index] ?? 0)
    }
    binary += part
  }
  return btoa(binary)
}

export async function readMobileComposerImageFile(file: File): Promise<MobileComposerPastedImage> {
  const base64 = encodeBase64(new Uint8Array(await file.arrayBuffer()))
  const mime = file.type.startsWith('image/') ? file.type : 'image/png'
  return { base64, uri: `data:${mime};base64,${base64}` }
}
