import { availableParallelism } from 'node:os'
import { runProcessSync } from '@orca/process-host'
import { describeProcessFailure } from './process-failure-message.mjs'
import { isDirectInvocation } from './script-entry-detection.mjs'
import {
  resolveTypecheckBunExecutable,
  resolveTypecheckCommand,
  selectTypecheckCompiler
} from './run-typecheck-projects-in-parallel.mjs'

const CONFIG = 'config/tsconfig.e2e.json'

export function runE2eTypecheck({
  root = process.cwd(),
  compiler = 'bun',
  execute = runProcessSync,
  resolveBunExecutable = resolveTypecheckBunExecutable
} = {}) {
  const selection = selectTypecheckCompiler(compiler, { root, resolveBunExecutable })
  const command = resolveTypecheckCommand(CONFIG, {
    ...selection,
    root,
    bunThreads: availableParallelism()
  })
  const result = execute({
    ...command,
    args: [...command.args, ...(compiler === 'native' ? ['--pretty', 'false'] : [])],
    timeoutMs: null,
    maxOutputBytes: 64 * 1024 * 1024
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const diagnosticExit = result.code === 1 || (compiler === 'native' && result.code === 2)
  // Incomplete diagnostics must never look like fixes when pruning the baseline.
  if (
    result.signal ||
    result.timedOut ||
    result.outputTruncated ||
    (result.code !== 0 && (!diagnosticExit || !/error TS\d+:/.test(output)))
  ) {
    throw new Error(`${compiler} ${CONFIG} failed to run: ${describeProcessFailure(result)}`)
  }
  return { code: result.code, output }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || (args.length === 1 && args[0] !== '--compiler=native')) {
      throw new Error('Usage: run-e2e-typecheck.mjs [--compiler=native]')
    }
    const result = runE2eTypecheck({ compiler: args.length ? 'native' : 'bun' })
    process.stdout.write(result.output)
    process.exitCode = result.code
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
