// `pnpm lint`: runs the independent lint steps in a bounded pool, printing output only for failures.
import { runProcess } from '@orca/process-host'
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { resolveOxlintInvocation } from './oxlint-cli-invocation.mjs'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

// package.json script names, slowest first so short steps fill in around them.
export const LINT_STEPS = [
  'check:import-boundaries',
  'verify:localization-extraction',
  'audit:anti-slop',
  'audit:code-quality:type-aware',
  'check:test-file-runners',
  'verify:localization-catalogs',
  'verify:localization-coverage',
  'verify:mobile-localization',
  'verify:mobile-localization-coverage',
  'lint:ast-grep-gates',
  'check:main-sync-spawn-ratchet',
  'check:has-restyle-scope',
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
  'check:daemon-blocking-call-ratchet',
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
function resolveLintCommands(scripts, root) {
  const pnpm = resolvePnpmCliInvocation()
  return LINT_STEPS.map((name) => {
    if (name === 'oxlint') {
      const { command, prefixArgs } = resolveOxlintInvocation(root)
      return { name, program: command, args: prefixArgs }
    }
    if (!scripts[name]) {
      throw new Error(`Lint step ${name} has no package.json script.`)
    }
    return { name, program: pnpm.command, args: [...pnpm.prefixArgs, 'run', name] }
  })
}

async function runStep({ name, program, args }, root) {
  const startedAt = performance.now()
  try {
    const result = await runProcess({ program, args, cwd: root, timeoutMs: null }, 'tail')
    return {
      name,
      ok: result.code === 0 && !result.signal && !result.timedOut,
      output: result.stdout + result.stderr,
      elapsed: `${((performance.now() - startedAt) / 1000).toFixed(1)}s`
    }
  } catch (error) {
    return { name, ok: false, output: error.message ?? String(error), elapsed: 'failed to start' }
  }
}

async function main(root, argv) {
  const startedAt = performance.now()
  const { scripts } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  // Individual linters also use multiple cores.
  let concurrency = Math.max(2, Math.min(4, Math.floor(availableParallelism() / 4)))
  let timings = false
  for (const argument of argv) {
    if (argument === '--') {
      continue
    }
    if (argument === '--timings') {
      timings = true
    } else if (/^--max-?workers=[1-9]\d*$/i.test(argument)) {
      concurrency = Number(argument.split('=')[1])
    } else {
      throw new Error(`Unknown option ${argument}. Use --maxWorkers=<n> or --timings.`)
    }
  }
  const steps = resolveLintCommands(scripts, root)
  const results = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, steps.length) }, async () => {
      while (next < steps.length) {
        const result = await runStep(steps[next++], root)
        if (!result.ok) {
          console.error(`\n✗ ${result.name} (${result.elapsed})\n${result.output.trimEnd()}`)
        } else if (timings) {
          console.log(`✓ ${result.name} (${result.elapsed})`)
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
  try {
    process.exitCode = await main(path.resolve(import.meta.dirname, '../..'), process.argv.slice(2))
  } catch (error) {
    console.error(`lint: ${error.message ?? error}`)
    process.exitCode = 1
  }
}
