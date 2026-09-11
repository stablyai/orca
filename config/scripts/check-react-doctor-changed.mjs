import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { resolvePullRequestDiffBase } from './git-pull-request-diff-base.mjs'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

const requestedBase =
  process.argv.slice(2).find((argument) => argument !== '--') ??
  process.env.ORCA_CODE_QUALITY_BASE ??
  'origin/main'
const base = resolvePullRequestDiffBase(process.cwd(), requestedBase)
// Why validate rather than trust: `base` arrives from argv or the environment and
// below it can reach cmd.exe unquoted, because resolvePnpmCliInvocation still
// falls back to a shell when it cannot find a directly spawnable pnpm. It accepts
// SHAs, tags, ref paths and the ^ ~ .. suffixes -- not reflog syntax like HEAD@{1},
// because braces stay out of anything bound for cmd.exe. The error names the base.
const GIT_REVISION = /^[A-Za-z0-9._/@^~-]+$/
if (!GIT_REVISION.test(base)) {
  throw new Error(`Refusing to pass an unsafe diff base to pnpm: ${base}`)
}
// Why the shim and not a direct binary: `dlx` fetches react-doctor on demand, so
// only the pnpm CLI can run it. resolvePnpmCliInvocation prefers whatever
// npm_execpath exposes -- pnpm 12's own pnpm.exe, spawned with no shell.
const { command, prefixArgs, shell } = resolvePnpmCliInvocation()
const result = spawnSync(
  command,
  [
    ...prefixArgs,
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
  { stdio: 'inherit', shell, windowsHide: true }
)

if (result.error) {
  throw result.error
}
process.exit(result.status ?? 1)
