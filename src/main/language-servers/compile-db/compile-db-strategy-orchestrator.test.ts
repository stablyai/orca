import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { FSWatcher, watch as fsWatch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ProcessResult } from '../../../shared/child-process/process-spec'
import type { runProcess } from '../../../shared/child-process/run-process'
import { createCompileDbStrategy } from './compile-db-strategy-orchestrator'
import {
  CLANGD_CONFIG_FILENAME,
  buildClangdConfigForClangCl,
  buildClangdConfigDegradedTemplate
} from './clangd-config-writer'
import {
  GN_BUILD_FILE,
  GN_BUILD_NINJA_FILENAME,
  GN_NO_OUT_DIR_TOAST,
  GN_ROOT_MARKER,
  type CompileDbStrategyHooks
} from './compile-db-strategy-types'

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'db-strategy-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true })
  }
})

type Hooks = {
  onStatus: MockInstance<(text: string | null) => void>
  onDegraded: MockInstance<(message: string | null) => void>
  onToast: MockInstance<(message: string) => void>
  onLog: MockInstance<(line: string) => void>
}

function makeHooks(): CompileDbStrategyHooks & Hooks {
  return {
    onStatus: vi.fn(),
    onDegraded: vi.fn(),
    onToast: vi.fn(),
    onLog: vi.fn()
  } as unknown as CompileDbStrategyHooks & Hooks
}

function runner(result: Partial<ProcessResult> = {}): typeof runProcess {
  return vi.fn(
    async () =>
      ({
        code: 0,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        ...result
      }) as ProcessResult
  ) as unknown as typeof runProcess
}

// A no-op watcher that never fires; tests drive regeneration through resolve().
function silentWatch(): typeof fsWatch {
  return (() => ({
    close: () => {},
    on: () => {},
    unref: () => {}
  })) as unknown as typeof fsWatch
}

// New-GN `gn help gen` excerpt advertising the add-export switch.
const NEW_GN_HELP = 'gn gen: Generates ninja files.\n  --add-export-compile-commands=<pattern>\n'
// Old-GN help: only the deprecated switch.
const OLD_GN_HELP = 'gn gen: Generates ninja files.\n  --export-compile-commands[=bool]\n'

/**
 * A runner that dispatches by program for GN tests: `gn help gen` returns the
 * configured help (断代 probe); `gn gen` returns exit 0 and writes the db; `ninja`
 * returns stdout = dbJson. Lets one injected runner serve probe + generate.
 */
function gnRunner(opts: {
  help?: string
  genExit?: number
  dbJson?: string
  ninjaExit?: number
}): typeof runProcess {
  return vi.fn(async (spec: { program: string; args: readonly string[] }) => {
    if (spec.program === 'gn' && spec.args[0] === 'help') {
      return {
        code: 0,
        signal: null,
        stdout: opts.help ?? NEW_GN_HELP,
        stderr: '',
        timedOut: false
      } as ProcessResult
    }
    if (spec.program === 'gn' && spec.args[0] === 'gen') {
      const outDir = spec.args[1] ?? ''
      if ((opts.genExit ?? 0) === 0 && opts.dbJson !== undefined) {
        mkdirSync(outDir, { recursive: true })
        writeFileSync(join(outDir, 'compile_commands.json'), opts.dbJson)
      }
      return {
        code: opts.genExit ?? 0,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false
      } as ProcessResult
    }
    if (spec.program === 'ninja') {
      if ((opts.ninjaExit ?? 0) === 0 && opts.dbJson !== undefined) {
        const outDir = spec.args[1] ?? ''
        mkdirSync(outDir, { recursive: true })
        writeFileSync(join(outDir, 'compile_commands.json'), opts.dbJson)
      }
      return {
        code: opts.ninjaExit ?? 0,
        signal: null,
        stdout: opts.dbJson ?? '[]',
        stderr: '',
        timedOut: false
      } as ProcessResult
    }
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false } as ProcessResult
  }) as unknown as typeof runProcess
}

/** Creates a .gn root marker so the orchestrator detects a GN project. */
function writeGnRootMarker(root: string, outDirRel = 'out/Default'): string {
  writeFileSync(join(root, GN_ROOT_MARKER), 'buildconfig = "//build/config/BUILDCONFIG.gn"\n')
  writeFileSync(join(root, GN_BUILD_FILE), 'executable("hello") { sources = ["hello.cpp"] }\n')
  const outDir = join(root, outDirRel)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, GN_BUILD_NINJA_FILENAME), 'rule cc\n')
  return outDir
}

describe('createCompileDbStrategy — existing db (spec D9)', () => {
  it('returns the detected dir and never runs cmake (no generation needed)', async () => {
    const root = makeTempRoot()
    mkdirSync(join(root, 'build-cc'))
    writeFileSync(join(root, 'build-cc', 'compile_commands.json'), '[]')
    const run = vi.fn(runner()) as unknown as typeof runProcess
    const strategy = createCompileDbStrategy(root, makeHooks(), run, silentWatch())
    const resolution = await strategy.resolve()
    expect(run).not.toHaveBeenCalled()
    expect(resolution).toEqual({ compileCommandsDir: join(root, 'build-cc'), degraded: false })
    strategy.dispose()
  })

  it('clears any prior degraded hint when a db is available', async () => {
    const root = makeTempRoot()
    mkdirSync(join(root, 'build'))
    writeFileSync(join(root, 'build', 'compile_commands.json'), '[]')
    const hooks = makeHooks()
    const strategy = createCompileDbStrategy(root, hooks, runner(), silentWatch())
    await strategy.resolve()
    expect(hooks.onDegraded).toHaveBeenCalledWith(null)
    strategy.dispose()
  })
})

describe('createCompileDbStrategy — CMake generation (spec D9)', () => {
  it('bare-configures into build/orca-lsp when no presets exist and returns that dir', async () => {
    const root = makeTempRoot()
    writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n')
    const run = vi.fn(runner()) as unknown as typeof runProcess
    const hooks = makeHooks()
    const strategy = createCompileDbStrategy(root, hooks, run, silentWatch())
    const resolution = await strategy.resolve()
    expect(run).toHaveBeenCalledTimes(1)
    const spec = (run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(spec.program).toBe('cmake')
    expect(spec.args).toContain('-DCMAKE_EXPORT_COMPILE_COMMANDS=ON')
    expect(resolution).toEqual({
      compileCommandsDir: join(root, 'build', 'orca-lsp'),
      degraded: false
    })
    strategy.dispose()
  })

  it('uses --preset <default> when CMakePresets.json exists', async () => {
    const root = makeTempRoot()
    writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n')
    writeFileSync(
      join(root, 'CMakePresets.json'),
      JSON.stringify({
        version: 3,
        configurePresets: [{ name: 'default', binaryDir: '${sourceDir}/out-preset' }]
      })
    )
    const run = vi.fn(runner()) as unknown as typeof runProcess
    const strategy = createCompileDbStrategy(root, makeHooks(), run, silentWatch())
    const resolution = await strategy.resolve()
    const spec = (run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(spec.args).toEqual(['--preset', 'default'])
    expect(resolution.compileCommandsDir).toBe(join(root, 'out-preset'))
    strategy.dispose()
  })

  it('never creates a repo-root symlink (only runProcess, no symlink APIs)', async () => {
    const root = makeTempRoot()
    writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n')
    const run = vi.fn(runner()) as unknown as typeof runProcess
    const strategy = createCompileDbStrategy(root, makeHooks(), run, silentWatch())
    const resolution = await strategy.resolve()
    // The dir is an explicit path under the worktree, never a symlink step.
    expect(resolution.compileCommandsDir).toBe(join(root, 'build', 'orca-lsp'))
    strategy.dispose()
  })
})

describe('createCompileDbStrategy — cl.exe injection (findings §8)', () => {
  it('writes .clangd Compiler: clang-cl when the generated db drives cl.exe', async () => {
    const root = makeTempRoot()
    writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n')
    // Simulate cmake writing a cl.exe db into build/orca-lsp.
    const run = vi.fn(async () => {
      const dbDir = join(root, 'build', 'orca-lsp')
      mkdirSync(dbDir, { recursive: true })
      writeFileSync(
        join(dbDir, 'compile_commands.json'),
        JSON.stringify([
          {
            directory: root,
            file: join(root, 'a.cpp'),
            arguments: ['C:\\VS\\VC\\Tools\\MSVC\\bin\\x64\\cl.exe', '/c', 'a.cpp']
          }
        ])
      )
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false } as ProcessResult
    }) as unknown as typeof runProcess
    const strategy = createCompileDbStrategy(root, makeHooks(), run, silentWatch())
    await strategy.resolve()
    const config = join(root, CLANGD_CONFIG_FILENAME)
    expect(existsSync(config)).toBe(true)
    expect(readFileSync(config, 'utf8')).toBe(buildClangdConfigForClangCl())
    strategy.dispose()
  })

  it('does not write .clangd when the db drives clang++/gcc', async () => {
    const root = makeTempRoot()
    writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n')
    const run = vi.fn(async () => {
      const dbDir = join(root, 'build', 'orca-lsp')
      mkdirSync(dbDir, { recursive: true })
      writeFileSync(
        join(dbDir, 'compile_commands.json'),
        JSON.stringify([
          { directory: root, file: join(root, 'a.cpp'), arguments: ['/usr/bin/clang++', 'a.cpp'] }
        ])
      )
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false } as ProcessResult
    }) as unknown as typeof runProcess
    const strategy = createCompileDbStrategy(root, makeHooks(), run, silentWatch())
    await strategy.resolve()
    expect(existsSync(join(root, CLANGD_CONFIG_FILENAME))).toBe(false)
    strategy.dispose()
  })

  it('never overwrites a user .clangd even when cl.exe is detected', async () => {
    const root = makeTempRoot()
    writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n')
    writeFileSync(join(root, CLANGD_CONFIG_FILENAME), '# user config\n')
    const run = vi.fn(async () => {
      const dbDir = join(root, 'build', 'orca-lsp')
      mkdirSync(dbDir, { recursive: true })
      writeFileSync(
        join(dbDir, 'compile_commands.json'),
        JSON.stringify([{ directory: root, file: 'a.cpp', arguments: ['cl.exe', '/c', 'a.cpp'] }])
      )
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false } as ProcessResult
    }) as unknown as typeof runProcess
    const strategy = createCompileDbStrategy(root, makeHooks(), run, silentWatch())
    await strategy.resolve()
    expect(readFileSync(join(root, CLANGD_CONFIG_FILENAME), 'utf8')).toBe('# user config\n')
    strategy.dispose()
  })
})

describe('createCompileDbStrategy — degraded state (spec §6)', () => {
  it('configure failure -> degraded hint + actionable toast + .clangd template; clangd dir still set', async () => {
    const root = makeTempRoot()
    writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n')
    const run = runner({ code: 1, stderr: 'CMake Error: bad target' })
    const hooks = makeHooks()
    const strategy = createCompileDbStrategy(root, hooks, run, silentWatch())
    const resolution = await strategy.resolve()
    expect(resolution.degraded).toBe(true)
    // clangd still starts — pointed at the expected dir so a later regenerate
    // surfaces automatically via clangd's own db-file watch.
    expect(resolution.compileCommandsDir).toBe(join(root, 'build', 'orca-lsp'))
    expect(hooks.onDegraded).toHaveBeenCalledWith(expect.stringContaining('降级'))
    expect(hooks.onToast).toHaveBeenCalledTimes(1)
    const toastArg = hooks.onToast.mock.calls[0]?.[0]
    expect(toastArg).toMatch(/cmake|configure|fail/i)
    // Degraded template written (write-once).
    expect(readFileSync(join(root, CLANGD_CONFIG_FILENAME), 'utf8')).toBe(
      buildClangdConfigDegradedTemplate()
    )
    strategy.dispose()
  })

  it('no CMakeLists.txt and no db -> degraded hint, no cmake run, no .clangd template', async () => {
    const root = makeTempRoot()
    const run = vi.fn(runner()) as unknown as typeof runProcess
    const hooks = makeHooks()
    const strategy = createCompileDbStrategy(root, hooks, run, silentWatch())
    const resolution = await strategy.resolve()
    expect(run).not.toHaveBeenCalled()
    expect(resolution).toEqual({ compileCommandsDir: null, degraded: true })
    expect(hooks.onDegraded).toHaveBeenCalledWith(expect.stringContaining('降级'))
    expect(existsSync(join(root, CLANGD_CONFIG_FILENAME))).toBe(false)
    strategy.dispose()
  })

  it('timeout configure -> degraded', async () => {
    const root = makeTempRoot()
    writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n')
    const run = runner({ code: null, timedOut: true })
    const hooks = makeHooks()
    const strategy = createCompileDbStrategy(root, hooks, run, silentWatch())
    const resolution = await strategy.resolve()
    expect(resolution.degraded).toBe(true)
    expect(hooks.onToast).toHaveBeenCalledTimes(1)
    strategy.dispose()
  })
})

describe('createCompileDbStrategy — regenerate on CMakeLists change (spec D9)', () => {
  it('re-runs configure when the listfile watcher fires', async () => {
    vi.useFakeTimers()
    const root = makeTempRoot()
    writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n')
    const run = vi.fn(runner()) as unknown as typeof runProcess

    // Capture the watcher's onChange so the test can drive it. Read through a
    // getter so TS control-flow analysis does not narrow the closure assignment.
    let onChange: (() => void) | null = null
    const getOnChange = (): (() => void) | null => onChange
    let capturedOpts: unknown = undefined
    const wrappedWatch = ((
      _dir: string,
      options: unknown,
      cb: (e: string, f: string | null) => void
    ) => {
      capturedOpts = options
      onChange = () => cb('change', 'CMakeLists.txt')
      return {
        close: () => {},
        on: () => {},
        unref: () => {}
      } as unknown as FSWatcher
    }) as unknown as typeof fsWatch

    const strategy = createCompileDbStrategy(root, makeHooks(), run, wrappedWatch)
    await strategy.resolve()
    expect(run).toHaveBeenCalledTimes(1)
    // CMakeLists.txt is root-only: watch stays non-recursive (scoped).
    expect((capturedOpts as { recursive?: boolean })?.recursive).toBe(false)

    getOnChange()?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(2)
    strategy.dispose()
    vi.useRealTimers()
  })

  it('clears the degraded hint after a regenerate succeeds', async () => {
    vi.useFakeTimers()
    const root = makeTempRoot()
    writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n')
    let call = 0
    const run = vi.fn(async () => {
      call += 1
      // First configure fails, second succeeds.
      const code = call === 1 ? 1 : 0
      if (code === 0) {
        const dbDir = join(root, 'build', 'orca-lsp')
        mkdirSync(dbDir, { recursive: true })
        writeFileSync(join(dbDir, 'compile_commands.json'), '[]')
      }
      return { code, signal: null, stdout: '', stderr: '', timedOut: false } as ProcessResult
    }) as unknown as typeof runProcess

    let onChange: (() => void) | null = null
    const getOnChange = (): (() => void) | null => onChange
    const wrappedWatch = ((
      _dir: string,
      _opts: unknown,
      cb: (e: string, f: string | null) => void
    ) => {
      onChange = () => cb('change', 'CMakeLists.txt')
      return {
        close: () => {},
        on: () => {},
        unref: () => {}
      } as unknown as FSWatcher
    }) as unknown as typeof fsWatch

    const hooks = makeHooks()
    const strategy = createCompileDbStrategy(root, hooks, run, wrappedWatch)
    const first = await strategy.resolve()
    expect(first.degraded).toBe(true)
    expect(hooks.onDegraded).toHaveBeenCalledWith(expect.stringContaining('降级'))

    getOnChange()?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect(hooks.onDegraded).toHaveBeenCalledWith(null)
    strategy.dispose()
    vi.useRealTimers()
  })
})

describe('createCompileDbStrategy — GN generation (spec D9)', () => {
  it('runs gn gen --add-export-compile-commands=//* on a configured out dir (new GN)', async () => {
    const root = makeTempRoot()
    const outDir = writeGnRootMarker(root)
    const dbJson = JSON.stringify([
      { directory: root, file: join(root, 'hello.cpp'), arguments: ['clang++', '-c', 'hello.cpp'] }
    ])
    const run = gnRunner({ dbJson })
    const hooks = makeHooks()
    const strategy = createCompileDbStrategy(root, hooks, run, silentWatch())
    const resolution = await strategy.resolve()
    // Probe (gn help gen) + generate (gn gen) both ran through the one runner.
    expect(run).toHaveBeenCalledTimes(2)
    const genCall = (run as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]
    expect(genCall.program).toBe('gn')
    expect(genCall.args[0]).toBe('gen')
    expect(genCall.args).toContain('--add-export-compile-commands=//*')
    expect(resolution).toEqual({ compileCommandsDir: outDir, degraded: false })
    strategy.dispose()
  })

  it('injects .clangd Compiler: clang-cl when the GN db drives cl.exe', async () => {
    const root = makeTempRoot()
    writeGnRootMarker(root)
    const dbJson = JSON.stringify([
      {
        directory: root,
        file: join(root, 'hello.cpp'),
        arguments: ['C:\\VS\\VC\\bin\\cl.exe', '/c', 'hello.cpp']
      }
    ])
    const run = gnRunner({ dbJson })
    const strategy = createCompileDbStrategy(root, makeHooks(), run, silentWatch())
    await strategy.resolve()
    expect(readFileSync(join(root, CLANGD_CONFIG_FILENAME), 'utf8')).toBe(
      buildClangdConfigForClangCl()
    )
    strategy.dispose()
  })

  it('falls back to ninja -t compdb -x when GN is old (断代 false)', async () => {
    const root = makeTempRoot()
    const outDir = writeGnRootMarker(root)
    const dbJson = JSON.stringify([
      { directory: root, file: join(root, 'hello.cpp'), arguments: ['clang++', '-c', 'hello.cpp'] }
    ])
    // Old-GN help lacks --add-export-compile-commands -> probe returns false.
    const run = gnRunner({ help: OLD_GN_HELP, dbJson })
    const hooks = makeHooks()
    const strategy = createCompileDbStrategy(root, hooks, run, silentWatch())
    const resolution = await strategy.resolve()
    expect(run).toHaveBeenCalledTimes(2)
    const genCall = (run as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]
    expect(genCall.program).toBe('ninja')
    expect(genCall.args).toEqual([
      '-C',
      outDir,
      '-t',
      'compdb',
      '-x',
      'cc',
      'cxx',
      'objc',
      'objcxx'
    ])
    // ninja stdout was written to the out dir as compile_commands.json.
    expect(readFileSync(join(outDir, 'compile_commands.json'), 'utf8')).toBe(dbJson)
    expect(resolution).toEqual({ compileCommandsDir: outDir, degraded: false })
    strategy.dispose()
  })

  it('ninja fallback includes -x on every platform (Windows @rsp requirement)', async () => {
    const root = makeTempRoot()
    writeGnRootMarker(root)
    const run = gnRunner({ help: OLD_GN_HELP, dbJson: '[]' })
    const strategy = createCompileDbStrategy(root, makeHooks(), run, silentWatch())
    await strategy.resolve()
    const genCall = (run as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]
    expect(genCall.args).toContain('-x')
    strategy.dispose()
  })
})

describe('createCompileDbStrategy — GN degradation (no out dir, spec D9)', () => {
  it('degrades + surfaces the "run gn gen first" toast and never guesses args.gn', async () => {
    const root = makeTempRoot()
    writeFileSync(join(root, GN_ROOT_MARKER), 'buildconfig = "//BUILDCONFIG.gn"\n')
    writeFileSync(join(root, GN_BUILD_FILE), 'executable("x") {}\n')
    // No out dir with build.ninja.
    const run = gnRunner({})
    const hooks = makeHooks()
    const strategy = createCompileDbStrategy(root, hooks, run, silentWatch())
    const resolution = await strategy.resolve()
    expect(run).not.toHaveBeenCalled()
    expect(resolution).toEqual({ compileCommandsDir: null, degraded: true })
    expect(hooks.onDegraded).toHaveBeenCalledWith(expect.stringContaining('降级'))
    expect(hooks.onToast).toHaveBeenCalledWith(GN_NO_OUT_DIR_TOAST)
    // No degraded .clangd template (we don't know the build dir; don't guess).
    expect(existsSync(join(root, CLANGD_CONFIG_FILENAME))).toBe(false)
    strategy.dispose()
  })

  it('a .gn project with a pre-existing db reuses it (no generation)', async () => {
    const root = makeTempRoot()
    writeGnRootMarker(root)
    // A pre-existing db in a build dir the detector knows (\`out\`) short-
    // circuits generation; the out/Default build.ninja still exists, but the
    // db in \`out\` is reused as-is.
    mkdirSync(join(root, 'out'), { recursive: true })
    writeFileSync(join(root, 'out', 'compile_commands.json'), '[]')
    const run = gnRunner({ dbJson: '[]' })
    const hooks = makeHooks()
    const strategy = createCompileDbStrategy(root, hooks, run, silentWatch())
    const resolution = await strategy.resolve()
    expect(run).not.toHaveBeenCalled()
    expect(resolution.degraded).toBe(false)
    expect(hooks.onDegraded).toHaveBeenCalledWith(null)
    strategy.dispose()
  })
})

describe('createCompileDbStrategy — regenerate on BUILD.gn/.gn change (spec D9)', () => {
  it('re-runs gn gen when BUILD.gn changes', async () => {
    vi.useFakeTimers()
    const root = makeTempRoot()
    writeGnRootMarker(root)
    const run = gnRunner({ dbJson: '[]' })

    let onChange: (() => void) | null = null
    const getOnChange = (): (() => void) | null => onChange
    const wrappedWatch = ((
      _dir: string,
      _opts: unknown,
      cb: (e: string, f: string | null) => void
    ) => {
      onChange = () => cb('change', 'BUILD.gn')
      return { close: () => {}, on: () => {}, unref: () => {} } as unknown as FSWatcher
    }) as unknown as typeof fsWatch

    const strategy = createCompileDbStrategy(root, makeHooks(), run, wrappedWatch)
    await strategy.resolve()
    // Probe + first generate.
    expect(run).toHaveBeenCalledTimes(2)

    getOnChange()?.()
    await vi.advanceTimersByTimeAsync(1000)
    // Regenerate re-runs gn gen (no re-probe).
    expect(run).toHaveBeenCalledTimes(3)
    const regenCall = (run as ReturnType<typeof vi.fn>).mock.calls[2]?.[0]
    expect(regenCall.program).toBe('gn')
    expect(regenCall.args[0]).toBe('gen')
    strategy.dispose()
    vi.useRealTimers()
  })

  it('re-runs when .gn (root marker) changes', async () => {
    vi.useFakeTimers()
    const root = makeTempRoot()
    writeGnRootMarker(root)
    const run = gnRunner({ dbJson: '[]' })

    let onChange: (() => void) | null = null
    const getOnChange = (): (() => void) | null => onChange
    const wrappedWatch = ((
      _dir: string,
      _opts: unknown,
      cb: (e: string, f: string | null) => void
    ) => {
      onChange = () => cb('change', '.gn')
      return { close: () => {}, on: () => {}, unref: () => {} } as unknown as FSWatcher
    }) as unknown as typeof fsWatch

    const strategy = createCompileDbStrategy(root, makeHooks(), run, wrappedWatch)
    await strategy.resolve()
    const before = (run as ReturnType<typeof vi.fn>).mock.calls.length
    getOnChange()?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect((run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1)
    strategy.dispose()
    vi.useRealTimers()
  })

  it('watches recursively so a subdir BUILD.gn edit regenerates (spec §8)', async () => {
    vi.useFakeTimers()
    const root = makeTempRoot()
    writeGnRootMarker(root)
    const run = gnRunner({ dbJson: '[]' })

    let opts: unknown = undefined
    let onChange: (() => void) | null = null
    const getOnChange = (): (() => void) | null => onChange
    const wrappedWatch = ((
      _dir: string,
      options: unknown,
      cb: (e: string, f: string | null) => void
    ) => {
      opts = options
      onChange = () => cb('change', 'src/foo/BUILD.gn')
      return { close: () => {}, on: () => {}, unref: () => {} } as unknown as FSWatcher
    }) as unknown as typeof fsWatch

    const strategy = createCompileDbStrategy(root, makeHooks(), run, wrappedWatch)
    await strategy.resolve()
    expect((opts as { recursive?: boolean })?.recursive).toBe(true)
    const before = (run as ReturnType<typeof vi.fn>).mock.calls.length
    getOnChange()?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect((run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1)
    strategy.dispose()
    vi.useRealTimers()
  })
})

describe('createCompileDbStrategy — GN vs CMake precedence (spec D9)', () => {
  it('routes a .gn project to GN even when a CMakeLists.txt also exists', async () => {
    const root = makeTempRoot()
    writeGnRootMarker(root)
    // Also drop a CMakeLists.txt; .gn wins (GN is the authoritative root marker).
    writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n')
    const run = gnRunner({ dbJson: '[]' })
    const strategy = createCompileDbStrategy(root, makeHooks(), run, silentWatch())
    const resolution = await strategy.resolve()
    const genCall = (run as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]
    expect(genCall.program).toBe('gn')
    expect(resolution.degraded).toBe(false)
    strategy.dispose()
  })
})
