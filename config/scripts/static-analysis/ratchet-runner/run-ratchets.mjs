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
export const MAIN_BLOCKING_RATCHETS = new Set([
  'check-main-blocking-api-ratchet.mjs',
  'check-main-blocking-helper-ratchet.mjs',
  'check-main-sync-fs-ratchet.mjs'
])

export function listRatchetScripts(scriptsDir) {
  return readdirSync(scriptsDir, { recursive: true })
    .filter(
      (name) => RATCHET_SCRIPT.test(path.basename(name)) && !RUN_ELSEWHERE.has(path.basename(name))
    )
    .sort((a, b) => {
      const left = path.basename(a)
      const right = path.basename(b)
      return left < right ? -1 : left > right ? 1 : 0
    })
}

export const MAIN_BLOCKING_RUNNER = path.join(
  'static-analysis',
  'ratchet-runner',
  'run-main-blocking-ratchets.mjs'
)
const HEAVY_RATCHETS = new Set(['check-react-compiler-compat-ratchet.mjs'])

function runRatchet(scriptsDir, name, root) {
  return new Promise((resolve) => {
    let output = ''
    const runtime =
      name === MAIN_BLOCKING_RUNNER && process.env.ORCA_MAIN_BLOCKING_RATCHET_RUNTIME === 'bun'
        ? 'bun'
        : process.execPath
    const child = spawn(runtime, [path.join(scriptsDir, name)], { cwd: root })
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', (error) =>
      resolve({ name: path.basename(name), ok: false, output: `${output}${error.message}` })
    )
    child.on('close', (code) => resolve({ name: path.basename(name), ok: code === 0, output }))
  })
}

async function main(root) {
  const scriptsDir = path.join(root, 'config', 'scripts')
  const discovered = listRatchetScripts(scriptsDir).filter(
    (name) => !MAIN_BLOCKING_RATCHETS.has(path.basename(name))
  )
  // Schedule the heaviest ratchets first so they do not become late stragglers.
  const pending = [
    MAIN_BLOCKING_RUNNER,
    ...discovered.filter((name) => HEAVY_RATCHETS.has(path.basename(name))),
    ...discovered.filter((name) => !HEAVY_RATCHETS.has(path.basename(name)))
  ]
  const failed = []
  await Promise.all(
    Array.from({ length: Math.max(2, availableParallelism()) }, async () => {
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
