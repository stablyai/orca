import { spawnProcess } from '@orca/process-host'
import { constants } from 'node:os'
import { delegateHostValidation } from './host-validation-budget.mjs'
import { resolvePnpmCliInvocation } from '../../tool-invocation/pnpm-cli-invocation.mjs'

if (!(await delegateHostValidation())) {
  const [program, ...args] = process.argv.slice(process.argv[2] === '--' ? 3 : 2)
  if (!program) {
    throw new Error('Usage: run-host-validation.mjs -- <program> [args...]')
  }
  const pnpm = program === 'pnpm' ? resolvePnpmCliInvocation() : null
  const child = spawnProcess({
    program: pnpm?.command ?? program,
    args: [...(pnpm?.prefixArgs ?? []), ...args],
    stdio: 'inherit'
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) =>
      resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1))
    )
  })
}
