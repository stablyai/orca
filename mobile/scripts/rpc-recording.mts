/**
 * Re-records the RPC recording goldens from the current tree.
 *
 *   pnpm --dir mobile rpc:record [<golden-id>...] [--prune]
 *
 * With ids, only those goldens are recorded (each derived test title starts with its golden id).
 * An unchanged behaviour re-records to identical bytes, so recording everything is always safe and
 * `git diff` shows only what moved. `--prune` deletes goldens the manifest no longer derives and
 * prints each one; without it they are only listed, and the census test keeps failing on them.
 */
import { createRequire } from 'node:module'
import { readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { derivedGoldens } from '../src/test-support/rpc-recording/derived-goldens.ts'
import { RECORDING_DRIVERS } from '../src/test-support/rpc-recording/recording-drivers.ts'
import { readScenarios } from '../src/test-support/rpc-recording/scenario-input.ts'

// Corpus takes 150–290s; allow ten minutes or old 120s budget kills it with misleading truncated failures.
const RECORDING_TIMEOUT_MS = 600_000
const root = resolve(import.meta.dirname, '../..')
const goldens = resolve(root, 'mobile/rpc-foundation/goldens')

const argv = process.argv.slice(2)
const prune = argv.includes('--prune')
const ids = argv.filter((arg) => arg !== '--prune')
const unknownFlag = ids.find((arg) => arg.startsWith('-'))
if (unknownFlag) {
  throw new Error(
    `Unknown option ${unknownFlag}. Usage: rpc-recording.mts [<golden-id>...] [--prune]`
  )
}
const derived = new Set(
  derivedGoldens(
    readScenarios(resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')).scenarios
  ).map((golden) => golden.id)
)
const unknownIds = ids.filter((id) => !derived.has(id))
if (unknownIds.length) {
  throw new Error(`The manifest derives no golden named ${unknownIds.join(', ')}`)
}

// Orphans come from the manifest, not the run, so a failed or killed run still lists or prunes them.
function handleOrphans(): void {
  const orphans = readdirSync(goldens)
    .filter((file) => file.endsWith('.json') && !derived.has(file.replace(/\.json$/, '')))
    .sort()
  for (const file of orphans) {
    if (prune) {
      rmSync(resolve(goldens, file))
      process.stdout.write(`pruned ${file}: the manifest no longer derives it\n`)
    } else {
      process.stdout.write(
        `orphaned ${file}: the manifest no longer derives it (--prune deletes it)\n`
      )
    }
  }
}

const escape = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const require = createRequire(resolve(root, 'mobile/package.json'))
try {
  const result = await runProcess({
    program: process.execPath,
    args: [
      resolve(require.resolve('vitest/package.json'), '../vitest.mjs'),
      'run',
      ...RECORDING_DRIVERS.map((driver) => `src/test-support/rpc-recording/${driver}`),
      ...(ids.length ? ['-t', `(?:^| )(?:${ids.map(escape).join('|')}): `] : [])
    ],
    cwd: resolve(root, 'mobile'),
    timeoutMs: RECORDING_TIMEOUT_MS,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', RPC_FOUNDATION_MODE: '--record' },
    // Stream output: multi-minute capture stays silent and truncates beyond 8 MiB.
    stdio: 'inherit'
  })
  if (result.timedOut) {
    // Distinguish killed partial reporter line from an actual test failure.
    throw new Error(
      `Recording did not finish within ${RECORDING_TIMEOUT_MS / 1000}s and was killed.`
    )
  }
  if (result.code !== 0) {
    process.exitCode = 1
  }
} finally {
  handleOrphans()
}
