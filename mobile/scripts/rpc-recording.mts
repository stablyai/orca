import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runProcess } from '../../src/shared/child-process/run-process.ts'
import { readScenarios } from '../src/test-support/rpc-recording/scenario-input.ts'

if (process.argv[2] !== '--record' || process.env.RPC_FOUNDATION_RECORD !== '1') {
  throw new Error(
    'Recording requires --record and RPC_FOUNDATION_RECORD=1; candidates use runStep1Exit'
  )
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
const require = createRequire(resolve(root, 'mobile/package.json'))
const result = await runProcess({
  program: process.execPath,
  args: [
    resolve(require.resolve('vitest/package.json'), '../vitest.mjs'),
    'run',
    'src/test-support/rpc-recording/pilot-recordings.test.ts',
    'src/test-support/rpc-recording/family-recordings.test.ts'
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
