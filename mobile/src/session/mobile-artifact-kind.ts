// Classifies a file path into how the mobile viewer should render it. Images
// route through files.readPreview (base64) and render as an <Image>; HTML routes
// through files.read (text) and renders in a sandboxed WebView with a source
// toggle; GLB models route through files.readPreview and render with three.js;
// everything else stays on the existing text/syntax path.
export type MobileArtifactKind = 'image' | 'model' | 'html' | 'other'

// Raster image extensions React Native's <Image> can decode from a base64 data
// URI (host returns these via files.readPreview). SVG is intentionally excluded:
// RN <Image> can't render image/svg+xml data URIs, so .svg falls through to the
// text path and renders as (meaningful) XML source instead of a blank image.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])

const HTML_EXTENSIONS = new Set(['html', 'htm'])

const MODEL_EXTENSIONS = new Set(['glb'])

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  // A leading dot (dotfile, no real extension) or no dot → no extension.
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
  if (MODEL_EXTENSIONS.has(ext)) {
    return 'model'
  }
  if (HTML_EXTENSIONS.has(ext)) {
    return 'html'
  }
  return 'other'
}

/** Kinds the host answers as base64 bytes from its preview read, not as text. */
export function isMobileBinaryPreviewArtifact(path: string): boolean {
  const kind = classifyMobileArtifact(path)
  return kind === 'image' || kind === 'model'
}
