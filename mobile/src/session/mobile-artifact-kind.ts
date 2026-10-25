export type MobileArtifactKind = 'image' | 'html' | 'other'

// RN Image cannot decode SVG data URIs; render SVG as XML source instead of a blank image.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])

const HTML_EXTENSIONS = new Set(['html', 'htm'])

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) {
    return ''
  }
  return base.slice(dot + 1).toLowerCase()
}

export function classifyMobileArtifact(path: string): MobileArtifactKind {
  const ext = extensionOf(path)
  if (IMAGE_EXTENSIONS.has(ext)) {
    return 'image'
  }
  if (HTML_EXTENSIONS.has(ext)) {
    return 'html'
  }
  return 'other'
}
