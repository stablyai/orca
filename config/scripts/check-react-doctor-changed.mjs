import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { resolvePullRequestDiffBase } from './git-pull-request-diff-base.mjs'

const requestedBase =
  process.argv.slice(2).find((argument) => argument !== '--') ??
  process.env.ORCA_CODE_QUALITY_BASE ??
  'origin/main'
const base = resolvePullRequestDiffBase(process.cwd(), requestedBase)
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const result = spawnSync(
  pnpm,
  [
    'dlx',
    'react-doctor@0.9.1',
    '.',
    '--yes',
    '--scope',
    'lines',
    '--base',
    base,
    '--include-untracked',
    '--no-dead-code',
    '--no-supply-chain',
    '--no-telemetry',
    '--blocking',
    'error'
  ],
  {
    stdio: 'inherit',
    // Why: Node refuses to spawn a .cmd without a shell, so on Windows this
    // gate threw EINVAL before react-doctor ever ran. See ensure-native-runtime.
    shell: process.platform === 'win32'
  }
)

if (result.error) {
  throw result.error
}
process.exit(result.status ?? 1)
