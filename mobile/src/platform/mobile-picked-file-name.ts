/** Extensions for the types a phone's file picker commonly reports. */
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

/** A name for a picked file whose shell could not report one: `attachment-<n>.<ext>`. */
export function mobilePickedFileFallbackName(mime: string, index: number): string {
  const base = mime.split(';')[0]!.trim().toLowerCase()
  const known = EXTENSION_BY_MIME[base]
  const subtype = base.split('/')[1] ?? ''
  const extension = known ?? (/^[a-z0-9]{1,8}$/.test(subtype) ? subtype : '')
  return extension ? `attachment-${index}.${extension}` : `attachment-${index}`
}
