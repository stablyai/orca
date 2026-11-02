export type MobileArtifactKind = 'image' | 'vector' | 'html' | 'other'

// SVG is read as text so the same reply feeds both the drawing and its source view.
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
  if (ext === 'svg') {
    return 'vector'
  }
  if (HTML_EXTENSIONS.has(ext)) {
    return 'html'
  }
  return 'other'
}
