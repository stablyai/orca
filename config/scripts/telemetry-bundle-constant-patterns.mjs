// Rolldown's minifier renames local declarations and prefers template literals.
// Keep the named form strict; the verifier handles the lowered pair below.
const DECLARED_NAME = '[A-Za-z_$][A-Za-z0-9_$]*'
const STRING_QUOTE = '["`]'

export const BUILD_IDENTITY_RE = new RegExp(
  `\\b(?:const|let|var)\\s+BUILD_IDENTITY\\s*=\\s*${STRING_QUOTE}(rc|stable)${STRING_QUOTE}`
)
export const WRITE_KEY_RE = new RegExp(
  `\\b(?:const|let|var)\\s+WRITE_KEY\\s*=\\s*${STRING_QUOTE}(phc_[A-Za-z0-9_-]+)${STRING_QUOTE}`
)
export const MINIFIED_TELEMETRY_CONSTANTS_RE = new RegExp(
  `\\b(?:const|let|var)\\s+${DECLARED_NAME}\\s*=\\s*${STRING_QUOTE}(rc|stable)${STRING_QUOTE}` +
    `\\s*,\\s*${DECLARED_NAME}\\s*=\\s*${STRING_QUOTE}(phc_[A-Za-z0-9_-]+)${STRING_QUOTE}`
)
