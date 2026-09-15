import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runProcess } from '../../src/shared/child-process/run-process.ts'
import { RECORDING_DRIVERS } from '../src/test-support/rpc-recording/recording-drivers.ts'
import { readScenarios } from '../src/test-support/rpc-recording/scenario-input.ts'

if (process.argv[2] !== '--record' || process.env.RPC_FOUNDATION_RECORD !== '1') {
  throw new Error('Recording requires --record and RPC_FOUNDATION_RECORD=1')
}

const root = resolve(import.meta.dirname, '../..')

const input = readScenarios(resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json'))

const baseline = await runProcess({
  program: 'git',
  args: [
    'diff',
    '--quiet',
    input.baseline,
    '--',
    'mobile/src',
    'src/shared',
    'mobile/pnpm-lock.yaml',
    // Only the recorder is exempt, and every golden pins `recorderSha256` over it instead.
    ':!mobile/src/test-support/rpc-recording'
  ],
  cwd: root
})

if (baseline.code !== 0) {
  throw new Error('Product sources or lockfile differ from the pinned main baseline')
}

// Why a second check: `git diff` only sees tracked paths, so an untracked module under the
// guarded trees can change resolution while the baseline check still passes — the golden would
// then carry a pinned baseline header it did not actually record against.
const untracked = await runProcess({
  program: 'git',
  args: [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    'mobile/src',
    'src/shared',
    ':!mobile/src/test-support/rpc-recording'
  ],
  cwd: root
})

if (untracked.code !== 0) {
  throw new Error(`Could not enumerate untracked product sources: ${untracked.stderr}`)
}

if (untracked.stdout.trim() !== '') {
  throw new Error(
    `Untracked product sources would not be pinned by the baseline:\n${untracked.stdout.trim()}`
  )
}

const require = createRequire(resolve(root, 'mobile/package.json'))

const result = await runProcess({
  program: process.execPath,
  args: [
    resolve(require.resolve('vitest/package.json'), '../vitest.mjs'),
    'run',
    ...RECORDING_DRIVERS.map((driver) => `src/test-support/rpc-recording/${driver}`)
  ],
  cwd: resolve(root, 'mobile'),
  timeoutMs: 120_000,
  env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', RPC_FOUNDATION_MODE: '--record' }
})

process.stdout.write(result.stdout)

process.stderr.write(result.stderr)

if (result.code !== 0) {
  process.exitCode = 1
}
