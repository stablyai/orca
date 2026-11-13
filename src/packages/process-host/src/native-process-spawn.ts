import {
  spawn,
  spawnSync,
  execFileSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
  type ExecFileSyncOptions
} from 'node:child_process'
import {
  nativeExecutableResolver,
  type NativeExecutableSelection
} from './native-executable-resolution'

type AttemptObserver = (file: string, args: readonly string[], blockMs: number) => void

function eligible(options: SpawnOptions): boolean {
  const stdio = options.stdio
  return (
    !options.shell &&
    options.uid === undefined &&
    options.gid === undefined &&
    (stdio === undefined ||
      typeof stdio === 'string' ||
      stdio.every(
        (value) =>
          value == null ||
          typeof value === 'number' ||
          value === 'pipe' ||
          value === 'ignore' ||
          value === 'inherit' ||
          value === 'overlapped'
      ))
  )
}

function spawnFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    'syscall' in error &&
    typeof error.syscall === 'string' &&
    /^spawn(?:Sync)?(?: |$)/.test(error.syscall)
  )
}

export function spawnNativeProcess(
  program: string,
  args: readonly string[],
  options: SpawnOptions,
  selection?: NativeExecutableSelection,
  observe?: AttemptObserver
): ChildProcess {
  let startedAt = performance.now()
  const selected = eligible(options)
    ? (selection ?? nativeExecutableResolver.resolve(program, options.env))
    : { program, file: program }
  const file = nativeExecutableResolver.file(selected, options.env)
  const launch = (binary: string): ChildProcess => {
    try {
      return spawn(binary, [...args], {
        ...options,
        ...(binary !== program ? { argv0: options.argv0 || program } : {})
      })
    } finally {
      observe?.(binary, args, performance.now() - startedAt)
      startedAt = performance.now()
    }
  }
  let child: ChildProcess
  try {
    child = launch(file)
  } catch (error) {
    if (file === program || !spawnFailure(error)) {
      throw error
    }
    const fallback = launch(program)
    if (fallback.pid && fallback.pid > 0) {
      nativeExecutableResolver.nativeFallbackStarted(selected)
    }
    return fallback
  }
  if (file === program || (child.pid && child.pid > 0)) {
    return child
  }
  // No operation started; Node owns closing this private failed handle and its pipes.
  child.on('error', () => {})
  const fallback = launch(program)
  if (fallback.pid && fallback.pid > 0) {
    nativeExecutableResolver.nativeFallbackStarted(selected)
  }
  return fallback
}

function noChildSyncFailure(result: unknown): boolean {
  if (result === null || typeof result !== 'object') {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Every read is compared with an exact value or passed to the unknown-value error guard.
  const value = result as {
    pid?: number
    status?: number | null
    signal?: unknown
    error?: unknown
  }
  return (
    value.pid === 0 &&
    value.status === null &&
    value.signal === null &&
    spawnFailure(value.error ?? result)
  )
}

function logicalError(error: unknown, file: string, program: string): void {
  if (!(error instanceof Error) || file === program) {
    return
  }
  for (const prefix of ['Command failed: ', 'spawnSync ', 'spawn ']) {
    if (error.message.startsWith(`${prefix}${file}`)) {
      error.message = `${prefix}${program}${error.message.slice(prefix.length + file.length)}`
      break
    }
  }
}

function runNativeSync<T>(
  program: string,
  args: readonly string[],
  options: SpawnSyncOptions,
  run: (file: string, options: SpawnSyncOptions) => T,
  started: (result: T) => boolean,
  observe?: AttemptObserver
): T {
  let startedAt = performance.now()
  const deadline = options.timeout && options.timeout > 0 ? startedAt + options.timeout : null
  const selected = eligible(options)
    ? nativeExecutableResolver.resolve(program, options.env)
    : { program, file: program }
  const file = nativeExecutableResolver.file(selected, options.env)
  const launch = (binary: string): T => {
    try {
      return run(binary, {
        ...options,
        ...(binary !== program ? { argv0: options.argv0 || program } : {}),
        ...(deadline ? { timeout: Math.max(1, Math.ceil(deadline - performance.now())) } : {})
      })
    } catch (error) {
      logicalError(error, binary, program)
      throw error
    } finally {
      observe?.(binary, args, performance.now() - startedAt)
      startedAt = performance.now()
    }
  }
  let result: T
  try {
    result = launch(file)
  } catch (error) {
    if (
      file === program ||
      !noChildSyncFailure(error) ||
      (deadline && performance.now() >= deadline)
    ) {
      throw error
    }
    try {
      const fallback = launch(program)
      if (started(fallback)) {
        nativeExecutableResolver.nativeFallbackStarted(selected)
      }
      return fallback
    } catch (fallbackError) {
      if (
        fallbackError &&
        typeof fallbackError === 'object' &&
        'pid' in fallbackError &&
        typeof fallbackError.pid === 'number' &&
        fallbackError.pid > 0
      ) {
        nativeExecutableResolver.nativeFallbackStarted(selected)
      }
      throw fallbackError
    }
  }
  if (
    file !== program &&
    noChildSyncFailure(result) &&
    (!deadline || performance.now() < deadline)
  ) {
    result = launch(program)
    if (started(result)) {
      nativeExecutableResolver.nativeFallbackStarted(selected)
    }
  }
  if (result && typeof result === 'object' && 'error' in result) {
    logicalError(result.error, file, program)
  }
  return result
}

export function spawnNativeProcessSync(
  program: string,
  args: readonly string[],
  options: SpawnSyncOptions,
  observe?: AttemptObserver
): SpawnSyncReturns<Buffer> {
  return runNativeSync(
    program,
    args,
    options,
    (file, opts) => spawnSync(file, [...args], { ...opts, encoding: null }),
    (result) => result.pid > 0,
    observe
  )
}

export function execNativeFileSync(
  program: string,
  args: readonly string[],
  options: ExecFileSyncOptions,
  observe?: AttemptObserver
): string | Buffer {
  return runNativeSync(
    program,
    args,
    options,
    (file, opts) => execFileSync(file, [...args], opts),
    () => true,
    observe
  )
}
