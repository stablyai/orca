import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

/**
 * Copy a script and its relative modules, preserving their paths in the fixture.
 *
 * Walked rather than listed: a module the script needs but the fixture never copied fails every
 * test in the suite with a module-resolution error that looks nothing like the defect it hides.
 */
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
  // `from`, bare and dynamic `import`, and plain `require` -- the Windows gates
  // are .cjs, and a module reached only by require or by a side-effect import is
  // the one nobody notices is missing until a subprocess fails with a
  // resolution error instead. Deliberately not `projectRequire`/`requireLocal`
  // wrappers: those specifiers are resolved against the project root at runtime,
  // not against this file, so following them would stage the wrong path.
  const source = readFileSync(scriptPath, 'utf8')
  const specifiers = source.matchAll(
    /(?:\bfrom|\brequire\s*\(|\bimport\s*\(|\bimport)\s*'(\.\.?\/[^']+)'/g
  )
  for (const [, specifier] of specifiers) {
    collectScriptModules(join(dirname(scriptPath), specifier), seen)
  }
  return seen
}
