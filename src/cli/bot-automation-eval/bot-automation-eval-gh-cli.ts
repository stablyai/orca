// The `gh` a benchmarked bot runs (bot-automation-eval-gh.ts): logs each write beside the home, where
// grading reads it; the shim already logged the call.
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EvalHostState } from './bot-automation-eval-host'
import { runGh } from './bot-automation-eval-gh'

const state: EvalHostState = JSON.parse(readFileSync(process.env.ORCA_EVAL_STATE ?? '', 'utf8'))
const argv = process.argv.slice(2)
const log = (entry: Record<string, unknown>) =>
  appendFileSync(process.env.ORCA_EVAL_LOG ?? '', `${JSON.stringify(entry)}\n`)
const result = runGh(state.github, argv, {
  stdin: () => readFileSync(0, 'utf8'),
  files: (path) => readFileSync(resolve(path), 'utf8')
})
for (const write of result.writes) {
  log({ kind: 'write', ...write })
}
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
process.exit(result.code)
