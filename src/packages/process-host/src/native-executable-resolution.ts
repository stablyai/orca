import { accessSync, constants, statSync, type Stats } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { posix } from 'node:path'

type Entry = { file: string | null; stamp: string; expiresAt: number }
const NATIVE_LOOKUP = Symbol('native lookup required')
type ProbeResult = string | null | typeof NATIVE_LOOKUP
export type NativeExecutableSelection = {
  program: string
  file: string
  key?: string
  entry?: Entry
}

function stamp(stats: Stats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs, stats.mode].join(':')
}

function statFailure(error: unknown): null | typeof NATIVE_LOOKUP {
  return error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ? null
    : NATIVE_LOOKUP
}

function probeSync(file: string): ProbeResult {
  let stats: Stats
  try {
    stats = statSync(file)
  } catch (error) {
    return statFailure(error)
  }
  if (!stats.isFile()) {
    return NATIVE_LOOKUP
  }
  try {
    accessSync(file, constants.X_OK)
    return stamp(stats)
  } catch {
    return NATIVE_LOOKUP
  }
}

async function probeAsync(file: string): Promise<ProbeResult> {
  let stats: Stats
  try {
    stats = await stat(file)
  } catch (error) {
    return statFailure(error)
  }
  if (!stats.isFile()) {
    return NATIVE_LOOKUP
  }
  try {
    await access(file, constants.X_OK)
    return stamp(stats)
  } catch {
    return NATIVE_LOOKUP
  }
}

/** Candidates are not proof of a runnable program; native spawning decides that. */
export class NativeExecutableResolver {
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, Promise<NativeExecutableSelection>>()

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly now: () => number = () => performance.now()
  ) {}

  private key(program: string, env: NodeJS.ProcessEnv): string | null {
    const path = env.PATH
    return this.platform === 'darwin' &&
      program.length > 0 &&
      !program.includes('/') &&
      !program.includes('\0') &&
      typeof path === 'string' &&
      path.length > 0 &&
      path.split(':').every((entry) => posix.isAbsolute(entry))
      ? JSON.stringify([program, path])
      : null
  }

  private store(key: string, entry: Entry): void {
    if (!this.entries.has(key) && this.entries.size >= 512) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) {
        this.entries.delete(oldest)
      }
    }
    this.entries.set(key, entry)
  }

  private *lookup(
    program: string,
    path: string | undefined,
    key: string | null
  ): Generator<string, NativeExecutableSelection, ProbeResult> {
    const native = { program, file: program }
    if (key === null) {
      return native
    }
    let previous = this.entries.get(key)
    if (previous && previous.expiresAt <= this.now()) {
      this.entries.delete(key)
      previous = undefined
    }
    if (previous?.file === null) {
      return native
    }
    if (previous?.file) {
      const validated = yield previous.file
      if (this.entries.get(key) !== previous || previous.file === null) {
        return native
      }
      if (validated === previous.stamp) {
        return { program, file: previous.file, key, entry: previous }
      }
      this.entries.delete(key)
      previous = undefined
    }
    for (const directory of path!.split(':')) {
      // Normalizing '..' would change discovery through symlinked PATH directories.
      const file = `${directory}/${program}`
      const found = yield file
      if (found === NATIVE_LOOKUP) {
        return native
      }
      if (found !== null) {
        // An overlapping lookup or failed launch may already have replaced this selection.
        if (this.entries.get(key) !== previous) {
          return native
        }
        const entry = { file, stamp: found, expiresAt: this.now() + 30_000 }
        this.store(key, entry)
        return { program, file, key, entry }
      }
    }
    if (this.entries.get(key) === previous) {
      this.entries.delete(key)
    }
    return native
  }

  resolve(program: string, env: NodeJS.ProcessEnv = process.env): NativeExecutableSelection {
    const walk = this.lookup(program, env.PATH, this.key(program, env))
    let step = walk.next()
    while (!step.done) {
      step = walk.next(probeSync(step.value))
    }
    return step.value
  }

  resolveAsync(
    program: string,
    env: NodeJS.ProcessEnv = process.env
  ): Promise<NativeExecutableSelection> {
    const key = this.key(program, env)
    const path = env.PATH
    if (key !== null) {
      const pending = this.pending.get(key)
      if (pending) {
        return pending
      }
    }
    const lookup = async (): Promise<NativeExecutableSelection> => {
      const walk = this.lookup(program, path, key)
      let step = walk.next()
      while (!step.done) {
        step = walk.next(await probeAsync(step.value))
      }
      return step.value
    }
    const result = lookup()
    if (key !== null) {
      if (this.pending.size >= 512) {
        const oldest = this.pending.keys().next().value
        if (oldest !== undefined) {
          this.pending.delete(oldest)
        }
      }
      this.pending.set(key, result)
      const cleanup = (): void => {
        if (this.pending.get(key) === result) {
          this.pending.delete(key)
        }
      }
      void result.then(cleanup, cleanup)
    }
    return result
  }

  file(selection: NativeExecutableSelection, env: NodeJS.ProcessEnv = process.env): string {
    const { key, entry } = selection
    return key &&
      entry &&
      (key !== JSON.stringify([selection.program, env.PATH]) ||
        entry.expiresAt <= this.now() ||
        this.entries.get(key) !== entry ||
        entry.file === null)
      ? selection.program
      : selection.file
  }

  nativeFallbackStarted(selection: NativeExecutableSelection): void {
    if (selection.key && this.entries.get(selection.key) === selection.entry && selection.entry) {
      selection.entry.file = null
    }
  }
}

export const nativeExecutableResolver = new NativeExecutableResolver()
