export type MobileAttachmentFileKind =
  | 'video'
  | 'audio'
  | 'archive'
  | 'image'
  | 'spreadsheet'
  | 'document'
  | 'code'
  | 'file'

const EXTENSION_KINDS: readonly {
  readonly kind: MobileAttachmentFileKind
  readonly extensions: readonly string[]
}[] = [
  { kind: 'video', extensions: ['mov', 'mp4', 'm4v', 'mkv', 'avi', 'webm', 'hevc'] },
  { kind: 'audio', extensions: ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'aiff'] },
  { kind: 'archive', extensions: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'] },
  { kind: 'image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp'] },
  { kind: 'spreadsheet', extensions: ['xls', 'xlsx', 'csv', 'tsv', 'numbers'] },
  {
    kind: 'document',
    extensions: ['txt', 'md', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'rtf', 'log']
  },
  {
    kind: 'code',
    extensions: ['json', 'js', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'sh', 'yml', 'yaml']
  }
]

const MIME_KINDS: readonly { readonly prefix: string; readonly kind: MobileAttachmentFileKind }[] =
  [
    { prefix: 'video/', kind: 'video' },
    { prefix: 'audio/', kind: 'audio' },
    { prefix: 'image/', kind: 'image' },
    { prefix: 'text/', kind: 'document' }
  ]

export function mobileAttachmentExtension(name: string): string | null {
  return /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? null
}

/** The extension decides first, then the MIME type, so a video, an archive and a document read differently at a glance. */
export function mobileAttachmentFileKind(name: string, mime?: string): MobileAttachmentFileKind {
  const extension = mobileAttachmentExtension(name)
  const byExtension = EXTENSION_KINDS.find(
    (entry) => extension !== null && entry.extensions.includes(extension)
  )
  if (byExtension) {
    return byExtension.kind
  }
  return MIME_KINDS.find((entry) => mime?.startsWith(entry.prefix))?.kind ?? 'file'
}
