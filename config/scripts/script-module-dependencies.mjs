import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

// Walk/copy relative modules instead of maintaining fixture list: omitted dependencies hide target failures behind resolution errors.
export function copyScriptWithLocalModules(sourceScriptPath, destinationScriptsDir) {
  mkdirSync(destinationScriptsDir, { recursive: true })
  for (const modulePath of collectScriptModules(sourceScriptPath)) {
    const destination = join(destinationScriptsDir, relative(dirname(sourceScriptPath), modulePath))
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(modulePath, destination)
  }
}

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
  return seen
}
