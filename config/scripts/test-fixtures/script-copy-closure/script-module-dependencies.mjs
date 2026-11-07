import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

/** Copy relative module dependencies and their explicit file-URL assets into an isolated script fixture. */
export function copyScriptWithLocalModules(sourceScriptPath, destinationScriptsDir) {
  mkdirSync(destinationScriptsDir, { recursive: true })
  for (const modulePath of collectScriptModules(sourceScriptPath)) {
    const destination = join(destinationScriptsDir, relative(dirname(sourceScriptPath), modulePath))
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(modulePath, destination)
  }
}

/** Follow local JavaScript imports recursively while retaining data assets as non-executable leaves. */
function collectScriptModules(scriptPath, seen = new Set()) {
  if (seen.has(scriptPath)) {
    return seen
  }
  seen.add(scriptPath)
  // Follow static/dynamic imports and plain require for CJS gates; exclude projectRequire/requireLocal, which resolve from project root rather than this module.
  const source = readFileSync(scriptPath, 'utf8')
  const specifiers = source.matchAll(
    /(?:\bfrom|\brequire\s*\(|\bimport\s*\(|\bimport)\s*'(\.\.?\/[^']+)'/g
  )
  for (const [, specifier] of specifiers) {
    collectScriptModules(join(dirname(scriptPath), specifier), seen)
  }
  for (const [, asset] of source.matchAll(
    /\bnew URL\(\s*'(\.\.?\/[^']+)'\s*,\s*import\.meta\.url\s*\)/g
  )) {
    seen.add(join(dirname(scriptPath), asset))
  }
  return seen
}
