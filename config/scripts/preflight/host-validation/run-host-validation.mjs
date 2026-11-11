import { spawnProcess } from '@orca/process-host'
import { constants } from 'node:os'
import { delegateHostValidation } from './host-validation-budget.mjs'
import { resolvePnpmCliInvocation } from '../../tool-invocation/pnpm-cli-invocation.mjs'

try {
  const argv = process.argv.slice(2)
  let waitTimeoutMs = null
  if (argv[0]?.startsWith('--wait-timeout=')) {
    const seconds = Number(argv.shift().slice('--wait-timeout='.length))
    waitTimeoutMs = seconds * 1000
    if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 0) {
      throw new Error('--wait-timeout must be a nonnegative number of seconds')
    }
  }
  if (argv[0] === '--') {
    argv.shift()
  }
  const [program, ...args] = argv
  if (!program) {
    throw new Error(
      'Usage: run-host-validation.mjs [--wait-timeout=<seconds>] -- <program> [args...]'
    )
  }
  if (!(await delegateHostValidation({ waitTimeoutMs }))) {
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
} catch (error) {
  console.error(`validation: ${error.message}`)
  process.exitCode = 1
}
