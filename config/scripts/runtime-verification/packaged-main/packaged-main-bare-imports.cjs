const { runtimeImportSpecifiers } = require('../skills-cli/verify-skills-cli-runtime.cjs')

// Excludes member require/import calls but admits spread operands; missing a real import blinds the guard.
const CANDIDATE_RE = /(?:(?<![.\w])|(?<=\.\.\.))(?:require|import)\s*\(\s*(["'`])([^"'`$]+)\1\s*\)/g

/**
 * The specifiers `source` really loads that `isMissing` flags. The regex only finds candidates:
 * code-generating libraries embed require() text in strings (ajv's standalone output), so a file
 * with a flagged candidate is parsed to keep only real calls.
 */
function missingBareImports(source, file, isMissing) {
  const candidates = new Set()
  for (const match of source.matchAll(CANDIDATE_RE)) {
    if (isMissing(match[2])) {
      candidates.add(match[2])
    }
  }
  if (candidates.size === 0) {
    return []
  }
  const loaded = new Set(runtimeImportSpecifiers(source, file))
  return [...candidates].filter((specifier) => loaded.has(specifier))
}

module.exports = { missingBareImports }
