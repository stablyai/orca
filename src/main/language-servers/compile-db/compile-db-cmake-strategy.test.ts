import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../../../shared/child-process/process-spec'
import type { runProcess } from '../../../shared/child-process/run-process'
import {
  bareConfigureBuildDir,
  buildBareCMakeConfigureArgs,
  buildPresetCMakeConfigureArgs,
  readDefaultCMakePreset,
  runCMakeConfigure
} from './compile-db-cmake-strategy'
import type { CMakeRunner } from './compile-db-strategy-types'

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cmake-strategy-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true })
  }
})

function okRunner(): CMakeRunner {
  return vi.fn(
    async () =>
      ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false }) as ProcessResult
  ) as unknown as CMakeRunner
}

describe('buildBareCMakeConfigureArgs', () => {
  it('emits -S . -B build/orca-lsp -DCMAKE_EXPORT_COMPILE_COMMANDS=ON', () => {
    expect(buildBareCMakeConfigureArgs()).toEqual([
      '-S',
      '.',
      '-B',
      join('build', 'orca-lsp'),
      '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'
    ])
  })
})

describe('buildPresetCMakeConfigureArgs', () => {
  it('emits --preset <name> only (preset owns the build dir)', () => {
    expect(buildPresetCMakeConfigureArgs('default')).toEqual(['--preset', 'default'])
  })
})

describe('bareConfigureBuildDir', () => {
  it('resolves the absolute build/orca-lsp dir under the worktree root', () => {
    const root = makeTempRoot()
    expect(bareConfigureBuildDir(root)).toBe(join(root, 'build', 'orca-lsp'))
  })
})

describe('readDefaultCMakePreset', () => {
  it('returns null when no presets file exists', () => {
    const root = makeTempRoot()
    expect(readDefaultCMakePreset(root)).toBeNull()
  })

  it('selects the first non-hidden configure preset and resolves ${sourceDir}', () => {
    const root = makeTempRoot()
    writeFileSync(
      join(root, 'CMakePresets.json'),
      JSON.stringify({
        version: 3,
        configurePresets: [
          { name: 'hidden-one', hidden: true, binaryDir: '${sourceDir}/out-hidden' },
          { name: 'default', binaryDir: '${sourceDir}/build' }
        ]
      })
    )
    const preset = readDefaultCMakePreset(root)
    expect(preset).toEqual({ name: 'default', binaryDir: join(root, 'build') })
  })

  it('resolves a relative binaryDir against the worktree root', () => {
    const root = makeTempRoot()
    writeFileSync(
      join(root, 'CMakePresets.json'),
      JSON.stringify({
        version: 3,
        configurePresets: [{ name: 'rel', binaryDir: 'my-build' }]
      })
    )
    expect(readDefaultCMakePreset(root)).toEqual({
      name: 'rel',
      binaryDir: join(root, 'my-build')
    })
  })

  it('keeps an absolute binaryDir verbatim', () => {
    const root = makeTempRoot()
    const abs = join(root, 'abs-build')
    writeFileSync(
      join(root, 'CMakePresets.json'),
      JSON.stringify({
        version: 3,
        configurePresets: [{ name: 'abs', binaryDir: abs }]
      })
    )
    expect(readDefaultCMakePreset(root)).toEqual({ name: 'abs', binaryDir: abs })
  })

  it('falls back to CMakeUserPresets.json when CMakePresets.json is absent', () => {
    const root = makeTempRoot()
    writeFileSync(
      join(root, 'CMakeUserPresets.json'),
      JSON.stringify({
        version: 4,
        configurePresets: [{ name: 'user-default', binaryDir: '${sourceDir}/user-build' }]
      })
    )
    expect(readDefaultCMakePreset(root)).toEqual({
      name: 'user-default',
      binaryDir: join(root, 'user-build')
    })
  })

  it('prefers CMakePresets.json over CMakeUserPresets.json', () => {
    const root = makeTempRoot()
    writeFileSync(
      join(root, 'CMakePresets.json'),
      JSON.stringify({ version: 3, configurePresets: [{ name: 'primary', binaryDir: 'p' }] })
    )
    writeFileSync(
      join(root, 'CMakeUserPresets.json'),
      JSON.stringify({ version: 4, configurePresets: [{ name: 'secondary', binaryDir: 's' }] })
    )
    expect(readDefaultCMakePreset(root)?.name).toBe('primary')
  })

  it('returns null when the presets file has no configurePresets', () => {
    const root = makeTempRoot()
    writeFileSync(join(root, 'CMakePresets.json'), JSON.stringify({ version: 3 }))
    expect(readDefaultCMakePreset(root)).toBeNull()
  })

  it('returns null for a malformed presets file', () => {
    const root = makeTempRoot()
    writeFileSync(join(root, 'CMakePresets.json'), '{ not json')
    expect(readDefaultCMakePreset(root)).toBeNull()
  })
})

describe('runCMakeConfigure', () => {
  it('runs the bare argv with cwd=worktreeRoot when no preset', async () => {
    const root = makeTempRoot()
    const runner = vi.fn(okRunner()) as unknown as typeof runProcess
    await runCMakeConfigure(root, null, runner)
    expect(runner).toHaveBeenCalledTimes(1)
    const spec = (runner as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(spec.program).toBe('cmake')
    expect(spec.args).toEqual(buildBareCMakeConfigureArgs())
    expect(spec.cwd).toBe(root)
  })

  it('runs --preset <name> when a preset is selected', async () => {
    const root = makeTempRoot()
    const runner = vi.fn(okRunner()) as unknown as typeof runProcess
    await runCMakeConfigure(root, { name: 'default', binaryDir: join(root, 'build') }, runner)
    const spec = (runner as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(spec.program).toBe('cmake')
    expect(spec.args).toEqual(['--preset', 'default'])
    expect(spec.cwd).toBe(root)
  })

  it('reports success when cmake exits 0', async () => {
    const root = makeTempRoot()
    const result = await runCMakeConfigure(root, null, okRunner())
    expect(result.success).toBe(true)
  })

  it('reports failure on a non-zero exit', async () => {
    const root = makeTempRoot()
    const runner = vi.fn(
      async () =>
        ({ code: 1, signal: null, stdout: '', stderr: 'boom', timedOut: false }) as ProcessResult
    ) as unknown as typeof runProcess
    const result = await runCMakeConfigure(root, null, runner)
    expect(result.success).toBe(false)
    expect(result.stderr).toBe('boom')
  })

  it('reports failure on a timeout', async () => {
    const root = makeTempRoot()
    const runner = vi.fn(
      async () =>
        ({ code: null, signal: null, stdout: '', stderr: '', timedOut: true }) as ProcessResult
    ) as unknown as typeof runProcess
    const result = await runCMakeConfigure(root, null, runner)
    expect(result.success).toBe(false)
  })
})
