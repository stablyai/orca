// `pnpm lint`: runs the independent lint steps in a bounded pool, printing output only for failures.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// package.json script names, slowest first so short steps fill in around them.
export const LINT_STEPS = [
  'check:import-boundaries',
  'verify:localization-extraction',
  'audit:anti-slop',
  'audit:code-quality:type-aware',
  'check:test-file-runners',
  'verify:localization-catalogs',
  'verify:localization-coverage',
  'lint:ast-grep-gates',
  'check:main-sync-spawn-ratchet',
  'lint:js-plugins',
  'oxlint',
  'check:dead-classes',
  'check:layout-writer-ratchets',
  'check:e2e-typecheck-ratchet',
  'check:focus-read-ratchet',
  'audit:code-quality:native',
  'check:legacy-relay-fence-ratchet',
  'check:runtime-electron-ratchet',
  'verify:rpc-params-catalog',
  'check:repo-host-read-ratchet',
  'test:ast-grep',
  'check:max-lines-ratchet',
  'check:mobile-shared-dependency-versions',
  'check:ts-nocheck-ratchet',
  'check:workspace-record-read-ratchet',
  'check:unproven-pty-retirement-ratchet',
  'check:node-runtime-pin',
  'check:path-literal-ratchet',
  'check:host-list-render-ratchet',
  'verify:skill-bundle-manifest',
  'check:reliability-gates',
  'verify:bundled-skill-guides',
  'check:readme-local-links',
  'check:id-only-store-write-ratchet',
  'verify:acp-protocol'
]

// Steps with no package script of their own run as the bare command.
const BARE_COMMANDS = {
  oxlint: 'oxlint',
  // process-host and compat-boundary imports from one TypeScript parse, as CI runs them.
  'check:import-boundaries': 'bun config/scripts/check-import-boundaries.mjs',
  // lint:ast-grep and the flaky-test ratchet from one scan, as CI runs them.
  'lint:ast-grep-gates': 'node config/scripts/ast-grep-gates.mjs'
}

function parseMaxWorkers(argv) {
  const argument = argv.find((value) => /^--max-?workers=\d+$/i.test(value))
  const requested = argument ? Number(argument.split('=')[1]) : 0
  // Most steps are multi-threaded themselves, so a quarter of the cores keeps the host responsive.
  return requested > 0 ? requested : Math.max(2, Math.floor(availableParallelism() / 4))
}

export function resolveLintCommands(scripts, steps = LINT_STEPS) {
  return steps.map((name) => {
    const command = scripts[name] ?? BARE_COMMANDS[name]
    if (!command) {
      throw new Error(`Lint step ${name} has no package.json script.`)
    }
    return { name, command }
  })
}

function runStep({ name, command }, root) {
  const startedAt = performance.now()
  return new Promise((resolve) => {
    let output = ''
    // Why a shell: package scripts are shell commands (`a && b`), as pnpm would run them.
    const child = spawn(command, { cwd: root, shell: true, windowsHide: true })
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    const finish = (ok, extra = '') =>
      resolve({
        name,
        ok,
        output: output + extra,
        elapsed: `${((performance.now() - startedAt) / 1000).toFixed(1)}s`
      })
    child.on('error', (error) => finish(false, String(error.message ?? error)))
    child.on('close', (code) => finish(code === 0))
  })
}

async function main(root, argv) {
  const startedAt = performance.now()
  const { scripts } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const steps = resolveLintCommands(scripts)
  const concurrency = parseMaxWorkers(argv)
  const results = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, steps.length) }, async () => {
      while (next < steps.length) {
        const result = await runStep(steps[next++], root)
        if (!result.ok) {
          console.error(`\n✗ ${result.name} (${result.elapsed})\n${result.output.trimEnd()}`)
        }
        results.push(result)
      }
    })
  )
  const failed = results.filter((result) => !result.ok)
  const elapsed = `${((performance.now() - startedAt) / 1000).toFixed(1)}s`
  if (failed.length > 0) {
    console.error(
      `\n✗ ${failed.length} of ${results.length} lint step(s) failed in ${elapsed}: ${failed.map((result) => result.name).join(', ')}`
    )
    return 1
  }
  console.log(`✓ ${results.length} lint step(s) passed in ${elapsed}.`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(path.resolve(import.meta.dirname, '../..'), process.argv.slice(2))
}
