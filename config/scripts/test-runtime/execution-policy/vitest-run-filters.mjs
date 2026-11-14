// Options that always consume the next argument. Anything else is treated as a flag, so an
// unlisted option's value becomes an extra filter: a wider scan, never a missed file.
const VALUE_OPTIONS = new Set([
  '-c',
  '--config',
  '--maxWorkers',
  '--project',
  '--reporter',
  '--outputFile',
  '--shard',
  '--pool',
  '--environment',
  '-t',
  '--testNamePattern',
  '--testTimeout',
  '--hookTimeout',
  '--retry',
  '--bail',
  '--sequence.seed'
])
// Modes where Vitest can select files beyond the command-line filters.
const UNSCOPED_OPTIONS = new Set(['-w', '--watch', '--dir', '-r', '--root', '--related'])

export const RUN_ARGS_ENV = 'ORCA_VITEST_RUN_ARGS'

/** Positional filters of a one-shot `vitest run`, or undefined when it may select any file. */
export function parseRunFilters(args) {
  if (args[0] !== 'run') {
    return undefined
  }
  const filters = []
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      return undefined
    }
    if (!arg.startsWith('-')) {
      filters.push(arg)
      continue
    }
    const name = arg.split('=')[0]
    if (UNSCOPED_OPTIONS.has(name)) {
      return undefined
    }
    if (!arg.includes('=') && VALUE_OPTIONS.has(name)) {
      index += 1
    }
  }
  return filters.length ? filters : undefined
}

// Ignore inherited filters unless argv identifies this runner's own Vitest invocation.
export function readRunFilters(env = process.env, argv = process.argv) {
  const launched = env[RUN_ARGS_ENV]
  if (!launched || launched !== JSON.stringify(argv.slice(2))) {
    return undefined
  }
  return parseRunFilters(argv.slice(2))
}
