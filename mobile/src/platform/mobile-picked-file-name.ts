const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/xml': 'xml',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic'
}

export function mobilePickedFileFallbackName(mime: string, index: number): string {
  const base = mime.split(';')[0]!.trim().toLowerCase()
  const known = EXTENSION_BY_MIME[base]
  const subtype = base.split('/')[1] ?? ''
  const extension = known ?? (/^[a-z0-9]{1,8}$/.test(subtype) ? subtype : '')
  return extension ? `attachment-${index}.${extension}` : `attachment-${index}`
}

// Images keep the host's orca-paste-*.png name, which transcript readers recognize as a pasted image.
export function isPickedImageMime(mime: string | null | undefined): boolean {
  return mime?.trim().toLowerCase().startsWith('image/') ?? false
}
