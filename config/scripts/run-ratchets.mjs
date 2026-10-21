import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Discover CI ratchets by filename; local lint keeps its separate explicit check list.
const RATCHET_SCRIPT = /^check-.+-ratchets?\.mjs$/
const RUN_ELSEWHERE = new Set([
  // Needs the PR diff base; the cross-version-wire job runs it.
  'check-runtime-launcher-protocol-ratchet.mjs',
  // Its own background preflight step, so it overlaps lint and typecheck.
  'check-main-sync-spawn-ratchet.mjs'
])

export function listRatchetScripts(scriptsDir) {
  return readdirSync(scriptsDir)
    .filter((name) => RATCHET_SCRIPT.test(name) && !RUN_ELSEWHERE.has(name))
    .sort()
}

function main(root) {
  const scriptsDir = path.join(root, 'config', 'scripts')
  const failed = []
  for (const name of listRatchetScripts(scriptsDir)) {
    console.log(`\n▶ ${name}`)
    const result = spawnSync(process.execPath, [path.join(scriptsDir, name)], {
      cwd: root,
      stdio: 'inherit'
    })
    if (result.error || result.status !== 0) {
      failed.push(name)
    }
  }
  if (failed.length > 0) {
    console.error(`\nFailed ratchets: ${failed.join(', ')}`)
    return 1
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd()))
}
