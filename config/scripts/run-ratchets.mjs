import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Discover CI ratchets by filename; local lint keeps its separate explicit check list.
const RATCHET_SCRIPT = /^check-.+-ratchets?\.mjs$/
const RUN_ELSEWHERE = new Set([
  // Needs the PR diff base; the cross-version-wire job runs it.
  'check-runtime-launcher-protocol-ratchet.mjs',
  // Its own background preflight step, so it overlaps lint and typecheck.
  'check-main-sync-spawn-ratchet.mjs',
  // ast-grep-gates.mjs checks it from the ast-grep lint scan instead of scanning again.
  'check-flaky-test-pattern-ratchet.mjs'
])

export function listRatchetScripts(scriptsDir) {
  return readdirSync(scriptsDir)
    .filter((name) => RATCHET_SCRIPT.test(name) && !RUN_ELSEWHERE.has(name))
    .sort()
}

function runRatchet(scriptsDir, name, root) {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(process.execPath, [path.join(scriptsDir, name)], { cwd: root })
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', (error) => resolve({ name, ok: false, output: `${output}${error.message}` }))
    child.on('close', (code) => resolve({ name, ok: code === 0, output }))
  })
}

// Each ratchet is a single-threaded scan; half the cores leaves room for the overlapping typecheck.
async function main(root) {
  const scriptsDir = path.join(root, 'config', 'scripts')
  const pending = listRatchetScripts(scriptsDir)
  const failed = []
  await Promise.all(
    Array.from({ length: Math.max(2, Math.floor(availableParallelism() / 2)) }, async () => {
      while (pending.length > 0) {
        const result = await runRatchet(scriptsDir, pending.shift(), root)
        // Whole per-script blocks, so concurrent ratchets never interleave their lines.
        process.stdout.write(`\n▶ ${result.name}\n${result.output}`)
        if (!result.ok) {
          failed.push(result.name)
        }
      }
    })
  )
  if (failed.length > 0) {
    console.error(`\nFailed ratchets: ${failed.sort().join(', ')}`)
    return 1
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.cwd())
}
