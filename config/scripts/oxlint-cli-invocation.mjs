import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

// Why not `pnpm exec oxlint` / `node_modules/.bin/oxlint.cmd`: both land on a
// Windows .cmd shim, and Node >= 20 refuses to spawn one without `shell: true`
// (the CVE-2024-27980 mitigation), so every lint gate died with EINVAL before
// linting anything. Oxlint's bin is a plain Node script, so run it under this
// process's own node — no shim, no shell, no quoting question.
export function resolveOxlintInvocation(root = process.cwd()) {
  const requireFromRoot = createRequire(path.join(root, 'package.json'))
  // Oxlint's "exports" hides ./bin, so read the manifest and walk to its bin entry.
  const manifestPath = requireFromRoot.resolve('oxlint/package.json')
  const binField = requireFromRoot('oxlint/package.json').bin
  const binEntry = typeof binField === 'string' ? binField : binField?.oxlint
  if (!binEntry) {
    throw new Error('oxlint package.json declares no "oxlint" bin entry.')
  }
  return {
    command: process.execPath,
    prefixArgs: [path.resolve(path.dirname(manifestPath), binEntry)]
  }
}
