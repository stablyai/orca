import process from 'node:process'
import { resolvePullRequestDiffBase } from './git-pull-request-diff-base.mjs'
import { runAuditTool } from './run-audit-tool.mjs'

const requestedBase =
  process.argv.slice(2).find((argument) => argument !== '--') ??
  process.env.ORCA_CODE_QUALITY_BASE ??
  'origin/main'
const base = resolvePullRequestDiffBase(process.cwd(), requestedBase)
// Accept revision syntax, never shell fragments or option injection.
const GIT_REVISION = /^(?!-)[A-Za-z0-9._/@^~-]+$/
if (!GIT_REVISION.test(base)) {
  throw new Error(`Refusing to pass an unsafe diff base to React Doctor: ${base}`)
}
const result = runAuditTool('react-doctor', [
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
])

process.exitCode = result.code === 0 && !result.signal && !result.timedOut ? 0 : result.code || 1
