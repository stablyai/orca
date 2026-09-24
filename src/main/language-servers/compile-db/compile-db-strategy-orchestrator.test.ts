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
import type { CompileDbStrategyHooks } from './compile-db-strategy-types'

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
    const wrappedWatch = ((_dir: string, cb: (e: string, f: string | null) => void) => {
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
    const wrappedWatch = ((_dir: string, cb: (e: string, f: string | null) => void) => {
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
