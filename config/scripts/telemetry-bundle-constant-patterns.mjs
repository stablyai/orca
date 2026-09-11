// The unminified bundle keeps these names. Production minification may rename
// them, but the injected identity and key remain adjacent in the declaration.
export const BUILD_IDENTITY_RE = /\b(?:const|let|var)\s+BUILD_IDENTITY\s*=\s*["`](rc|stable)["`]/
export const WRITE_KEY_RE = /\b(?:const|let|var)\s+WRITE_KEY\s*=\s*["`](phc_[A-Za-z0-9_-]+)["`]/
export const MINIFIED_TELEMETRY_RE =
  /\b(?:const|let|var)\s+[$\w]+\s*=\s*["'`](rc|stable)["'`][\s\S]{0,200}?[,$]\s*[$\w]+\s*=\s*["'`](phc_[A-Za-z0-9_-]+)["'`]/
