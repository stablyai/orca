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
  'image/apng': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/bmp': 'bmp',
  'image/x-bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/ico': 'ico',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic'
}

export function mobileFileExtensionForMime(mime: string): string {
  const base = mime.split(';')[0]!.trim().toLowerCase()
  const subtype = base.split('/')[1] ?? ''
  return EXTENSION_BY_MIME[base] ?? (/^[a-z0-9]{1,8}$/.test(subtype) ? subtype : '')
}

export function mobilePickedFileFallbackName(mime: string, index: number): string {
  const extension = mobileFileExtensionForMime(mime)
  return extension ? `attachment-${index}.${extension}` : `attachment-${index}`
}

// Images take the host's orca-paste-* name, which transcript readers recognize as a pasted image.
export function isPickedImageMime(mime: string | null | undefined): boolean {
  return mime?.trim().toLowerCase().startsWith('image/') ?? false
}
