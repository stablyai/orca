// Classifies a file path into how the mobile viewer should render it. Images and
// videos route through files.readPreview (base64) and render as an <Image> or a
// native player; HTML routes through files.read (text) and renders in a sandboxed
// WebView with a source toggle; everything else stays on the existing text/syntax path.
export type MobileArtifactKind = 'image' | 'video' | 'html' | 'other'

// Raster image extensions React Native's <Image> can decode from a base64 data
// URI (host returns these via files.readPreview). SVG is intentionally excluded:
// RN <Image> can't render image/svg+xml data URIs, so .svg falls through to the
// text path and renders as (meaningful) XML source instead of a blank image.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])

// Container formats both AVPlayer (iOS) and ExoPlayer (Android) decode. WebM/MKV
// are excluded: iOS can't play them, so they stay on the unavailable-binary path
// instead of opening a player that fails.
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov'])

const HTML_EXTENSIONS = new Set(['html', 'htm'])

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  // A leading dot (dotfile, no real extension) or no dot → no extension.
  if (dot <= 0) {
    return ''
  }
  return base.slice(dot + 1).toLowerCase()
}

// Images and videos come back as base64 from the *Preview read methods; text
// kinds use the plain reads.
export function isMobileBinaryPreviewPath(path: string): boolean {
  const kind = classifyMobileArtifact(path)
  return kind === 'image' || kind === 'video'
}

export function classifyMobileArtifact(path: string): MobileArtifactKind {
  const ext = extensionOf(path)
  if (IMAGE_EXTENSIONS.has(ext)) {
    return 'image'
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return 'video'
  }
  if (HTML_EXTENSIONS.has(ext)) {
    return 'html'
  }
  return 'other'
}
