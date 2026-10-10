import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

// Why not `pnpm exec <bin>` / `node_modules/.bin/<bin>.cmd`: both land on a Windows
// .cmd shim, and Node >= 20 refuses to spawn one without `shell: true` (the
// CVE-2024-27980 mitigation), so every gate that took that route died with EINVAL
// before doing any work. The oxc bins are plain Node scripts, so run them under this
// process's own node — no shim, no shell, no quoting question.
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
