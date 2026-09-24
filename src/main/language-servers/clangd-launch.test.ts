import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ORCA_CLANGD_PATH_ENV,
  buildClangdLaunch,
  detectExistingCompileCommandsDir,
  resolveClangdProgram
} from './clangd-launch'

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
