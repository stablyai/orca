const { runtimeImportSpecifiers } = require('../skills-cli/verify-skills-cli-runtime.cjs')

// Excludes member require/import calls but admits spread operands; missing a real import blinds the guard.
const CANDIDATE_RE = /(?:(?<![.\w])|(?<=\.\.\.))(?:require|import)\s*\(\s*(["'`])([^"'`$]+)\1\s*\)/g

/**
 * The specifiers `source` really loads that `isMissing` flags. The regex only finds candidates:
 * code-generating libraries embed require() text in strings (ajv's standalone output), so a file
 * with a flagged candidate is parsed to keep only real calls.
 */
function missingBareImports(source, file, isMissing) {
  const hasCandidate = [...source.matchAll(CANDIDATE_RE)].some((match) => isMissing(match[2]))
  if (!hasCandidate) {
    return []
  }
  // Decoded by the parser, so an escaped specifier (ASCII-only output) still matches its package.
  return [...new Set(runtimeImportSpecifiers(source, file).filter(isMissing))]
}

module.exports = { missingBareImports }
