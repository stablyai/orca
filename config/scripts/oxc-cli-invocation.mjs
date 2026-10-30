import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

// Run oxc’s Node script directly: Windows .cmd shims require shell:true after CVE-2024-27980, which our process wrapper forbids.
export function resolveOxcCliInvocation(packageName, binName, root = process.cwd()) {
  const requireFromRoot = createRequire(path.join(root, 'package.json'))
  // The oxc packages' "exports" hide ./bin, so read the manifest and walk to its bin entry.
  const manifestPath = requireFromRoot.resolve(`${packageName}/package.json`)
  const binField = requireFromRoot(`${packageName}/package.json`).bin
  const binEntry = typeof binField === 'string' ? binField : binField?.[binName]
  if (!binEntry) {
    throw new Error(`${packageName} package.json declares no "${binName}" bin entry.`)
  }
  return {
    command: process.execPath,
    prefixArgs: [path.resolve(path.dirname(manifestPath), binEntry)]
  }
}
