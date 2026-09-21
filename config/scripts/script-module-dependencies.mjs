import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Copy a script and every co-located module it imports into a fixture's `config/scripts`.
 *
 * Walked rather than listed: a module the script needs but the fixture never copied fails every
 * test in the suite with a module-resolution error that looks nothing like the defect it hides.
 */
export function copyScriptWithLocalModules(sourceScriptPath, destinationScriptsDir) {
  mkdirSync(destinationScriptsDir, { recursive: true })
  for (const modulePath of collectScriptModules(sourceScriptPath)) {
    copyFileSync(modulePath, join(destinationScriptsDir, basename(modulePath)))
  }
}

function collectScriptModules(scriptPath, seen = new Set()) {
  if (seen.has(scriptPath)) {
    return seen
  }
  seen.add(scriptPath)
  for (const [, specifier] of readFileSync(scriptPath, 'utf8').matchAll(/from '(\.\/[^']+)'/g)) {
    collectScriptModules(join(dirname(scriptPath), specifier), seen)
  }
  return seen
}
