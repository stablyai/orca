import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../../shared/child-process/process-spec'
import type { runProcess } from '../../shared/child-process/run-process'
import {
  CLANGD_VERSION_GATE_SUGGEST_UPGRADE_CEILING,
  ORCA_CLANGD_PATH_ENV,
  buildClangdLaunch,
  classifyClangdVersion,
  detectExistingCompileCommandsDir,
  parseClangdVersion,
  resolveClangdProgram,
  resolveClangdVersionGate
} from './clangd-launch'

type RunProcess = typeof runProcess

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'clangd-launch-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true })
  }
})

describe('detectExistingCompileCommandsDir', () => {
  it('finds a build dir holding compile_commands.json', () => {
    const root = makeTempRoot()
    mkdirSync(join(root, 'build-cc'))
    writeFileSync(join(root, 'build-cc', 'compile_commands.json'), '[]')
    expect(detectExistingCompileCommandsDir(root)).toBe(join(root, 'build-cc'))
  })

  it('prefers the first candidate in order when several exist', () => {
    const root = makeTempRoot()
    for (const dir of ['build-cc', 'out', 'build-release']) {
      mkdirSync(join(root, dir))
      writeFileSync(join(root, dir, 'compile_commands.json'), '[]')
    }
    expect(detectExistingCompileCommandsDir(root)).toBe(join(root, 'build-cc'))
  })

  it('falls back to a root-level compile_commands.json', () => {
    const root = makeTempRoot()
    writeFileSync(join(root, 'compile_commands.json'), '[]')
    expect(detectExistingCompileCommandsDir(root)).toBe(root)
  })

  it('ignores build dirs without a database and returns null when none exists', () => {
    const root = makeTempRoot()
    mkdirSync(join(root, 'build'))
    expect(detectExistingCompileCommandsDir(root)).toBeNull()
  })
})

describe('resolveClangdProgram', () => {
  it('honors the ORCA_CLANGD_PATH override verbatim', () => {
    expect(resolveClangdProgram({ [ORCA_CLANGD_PATH_ENV]: 'C:\\tools\\clangd.exe' })).toBe(
      'C:\\tools\\clangd.exe'
    )
  })

  it('trims the override and ignores it when blank', () => {
    const emptyHome = makeTempRoot()
    expect(
      resolveClangdProgram({ [ORCA_CLANGD_PATH_ENV]: '   ' }, { pathEnv: '', homePath: emptyHome })
    ).toBe('clangd')
  })
})

describe('buildClangdLaunch', () => {
  it('passes the detected dir explicitly and keeps info logging', () => {
    const root = makeTempRoot()
    mkdirSync(join(root, 'build'))
    writeFileSync(join(root, 'build', 'compile_commands.json'), '[]')
    const launch = buildClangdLaunch(root, {})
    expect(launch.args).toEqual([`--compile-commands-dir=${join(root, 'build')}`, '--log=info'])
  })

  it('omits the compile-commands flag when no database exists', () => {
    const root = makeTempRoot()
    const launch = buildClangdLaunch(root, {})
    expect(launch.args).toEqual(['--log=info'])
  })
})

describe('parseClangdVersion', () => {
  it('extracts the major from the canonical clangd version banner', () => {
    expect(
      parseClangdVersion(
        'LLVM (http://llvm.org/):\n  clangd version 16.0.6\n  Target: x86_64-pc-windows-msvc\n'
      )
    ).toBe(16)
  })

  it('parses a Linux-style banner with a trailing git suffix', () => {
    expect(
      parseClangdVersion('clangd version 14.0.6 (https://github.com/llvm/llvm-project.git ...)\n')
    ).toBe(14)
  })

  it('parses the spike standalone banner (23.x)', () => {
    expect(parseClangdVersion('clangd version 23.1.0\n')).toBe(23)
  })

  it('returns null when the banner carries no version', () => {
    expect(parseClangdVersion('clangd\n')).toBeNull()
    expect(parseClangdVersion('')).toBeNull()
  })
})

describe('classifyClangdVersion', () => {
  it('rejects when the binary is missing (null major)', () => {
    expect(classifyClangdVersion(null)).toBe('reject')
  })

  it('rejects a major below the 12 floor', () => {
    expect(classifyClangdVersion(11)).toBe('reject')
    expect(classifyClangdVersion(10)).toBe('reject')
  })

  it('suggests an upgrade for 12 through the ceiling', () => {
    expect(classifyClangdVersion(12)).toBe('suggest-upgrade')
    expect(classifyClangdVersion(CLANGD_VERSION_GATE_SUGGEST_UPGRADE_CEILING)).toBe(
      'suggest-upgrade'
    )
  })

  it('accepts a major above the suggest-upgrade ceiling', () => {
    expect(classifyClangdVersion(CLANGD_VERSION_GATE_SUGGEST_UPGRADE_CEILING + 1)).toBe('ok')
    expect(classifyClangdVersion(23)).toBe('ok')
  })
})

describe('resolveClangdVersionGate', () => {
  function fakeRunner(stdout: string, code: number | null = 0): RunProcess {
    return vi.fn(
      async () => ({ code, signal: null, stdout, stderr: '', timedOut: false }) as ProcessResult
    ) as unknown as RunProcess
  }

  it('reports ok with the parsed major for a modern clangd', async () => {
    const gate = await resolveClangdVersionGate('clangd', fakeRunner('clangd version 18.1.0\n'))
    expect(gate).toEqual({ kind: 'ok', major: 18, message: null })
  })

  it('reports suggest-upgrade for a 12-15 clangd with a friendly message', async () => {
    const gate = await resolveClangdVersionGate('clangd', fakeRunner('clangd version 13.0.1\n'))
    expect(gate.kind).toBe('suggest-upgrade')
    expect(gate.major).toBe(13)
    expect(gate.message).toMatch(/upgrade/i)
  })

  it('reports reject with an install hint when the major is below the floor', async () => {
    const gate = await resolveClangdVersionGate('clangd', fakeRunner('clangd version 11.1.0\n'))
    expect(gate.kind).toBe('reject')
    expect(gate.major).toBe(11)
    expect(gate.message).toMatch(/clangd 12|install/i)
  })

  it('reports reject with an install hint when the binary is absent (ENOENT)', async () => {
    const runner = vi.fn(async () => {
      throw new Error('spawn clangd ENOENT')
    }) as unknown as RunProcess
    const gate = await resolveClangdVersionGate('clangd', runner)
    expect(gate).toEqual({ kind: 'reject', major: null, message: expect.any(String) })
    expect(gate.message).toMatch(/clangd 12|install/i)
  })

  it('reports reject when the version banner is unparseable', async () => {
    const gate = await resolveClangdVersionGate('clangd', fakeRunner('not a version banner\n'))
    expect(gate.kind).toBe('reject')
    expect(gate.major).toBeNull()
  })
})
