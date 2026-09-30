import type { FileFilter } from 'electron'

// Why this table: Electron's file chooser maps accept MIME types through Chromium's net mime
// tables, which main-process JS cannot reach. These are the extensions those tables list.
const EXTENSIONS_BY_MIME: Record<string, readonly string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/avif': ['avif'],
  'image/svg+xml': ['svg', 'svgz'],
  'image/bmp': ['bmp'],
  'image/x-icon': ['ico'],
  'image/vnd.microsoft.icon': ['ico'],
  'image/tiff': ['tiff', 'tif'],
  'image/heic': ['heic'],
  'image/heif': ['heif'],
  'image/apng': ['apng'],
  'audio/mpeg': ['mp3'],
  'audio/mp3': ['mp3'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/ogg': ['ogg', 'oga', 'opus'],
  'audio/webm': ['weba'],
  'audio/flac': ['flac'],
  'audio/aac': ['aac'],
  'audio/mp4': ['m4a', 'mp4'],
  'audio/x-m4a': ['m4a'],
  'video/mp4': ['mp4', 'm4v', 'mp4v'],
  'video/webm': ['webm'],
  'video/ogg': ['ogv', 'ogm'],
  'video/quicktime': ['mov', 'qt'],
  'video/x-matroska': ['mkv'],
  'video/mpeg': ['mpeg', 'mpg'],
  'text/plain': ['txt', 'text'],
  'text/html': ['html', 'htm', 'shtml', 'ehtml'],
  'text/css': ['css'],
  'text/csv': ['csv'],
  'text/markdown': ['md', 'markdown'],
  'text/javascript': ['js', 'mjs'],
  'text/xml': ['xml'],
  'application/json': ['json'],
  'application/pdf': ['pdf'],
  'application/zip': ['zip'],
  'application/gzip': ['gz', 'tgz'],
  'application/x-gzip': ['gz', 'tgz'],
  'application/xml': ['xml', 'xsl', 'xbl'],
  'application/rtf': ['rtf'],
  'application/msword': ['doc', 'dot'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/wasm': ['wasm'],
  'application/octet-stream': ['bin', 'exe', 'com']
}

const DESCRIPTION_BY_WILDCARD: Record<string, string> = {
  'image/*': 'Image Files',
  'audio/*': 'Audio Files',
  'video/*': 'Video Files'
}

function extensionsForMime(mime: string): readonly string[] {
  if (mime.endsWith('/*')) {
    const prefix = mime.slice(0, -1)
    const all = Object.entries(EXTENSIONS_BY_MIME)
      .filter(([type]) => type.startsWith(prefix))
      .flatMap(([, extensions]) => extensions)
    return [...new Set(all)]
  }
  return EXTENSIONS_BY_MIME[mime] ?? []
}

/**
 * The dialog filters Electron's FileSelectHelper builds from an `accept` attribute: one filter
 * with every matched extension, plus "All Files" once anything matched.
 */
export function fileDialogFiltersForAccept(accept: string): FileFilter[] {
  const types = accept
    .split(',')
    .map((type) => type.trim().toLowerCase())
    .filter(Boolean)
  const extensions: string[] = []
  let validTypes = 0
  let description = ''
  for (const type of types) {
    const before = extensions.length
    if (type.startsWith('.')) {
      extensions.push(type.slice(1))
    } else {
      description = DESCRIPTION_BY_WILDCARD[type] ?? description
      extensions.push(...extensionsForMime(type))
    }
    if (extensions.length > before) {
      validTypes += 1
    }
  }
  if (validTypes === 0) {
    return []
  }
  if (validTypes > 1 || (!description && new Set(extensions).size > 1)) {
    description = 'Custom Files'
  }
  const unique = [...new Set(extensions)]
  return [
    { name: description || `${unique[0].toUpperCase()} Files`, extensions: unique },
    { name: 'All Files', extensions: ['*'] }
  ]
}
