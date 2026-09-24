import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLANGD_CONFIG_FILENAME,
  buildClangdConfigForClangCl,
  buildClangdConfigDegradedTemplate,
  compileCommandsUsesClangCl,
  writeClangdConfigIfAbsent,
  type CompileCommandEntry
} from './clangd-config-writer'

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'clangd-config-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true })
  }
})

describe('buildClangdConfigForClangCl', () => {
  it('writes the marker header + Compiler: clang-cl (no Remove flags)', () => {
    const content = buildClangdConfigForClangCl()
    expect(content).toContain('# Orca-managed clangd config')
    expect(content).toContain('CompileFlags:')
    expect(content).toMatch(/Compiler:\s*clang-cl/)
    // findings §8: no Remove flag list — clang-cl handles every MSVC flag.
    expect(content).not.toMatch(/Remove:/)
  })
})

describe('buildClangdConfigDegradedTemplate', () => {
  it('writes the marker header + CompilationDatabase pointer skeleton', () => {
    const content = buildClangdConfigDegradedTemplate()
    expect(content).toContain('# Orca-managed clangd config')
    expect(content).toMatch(/CompilationDatabase:/)
  })
})

describe('writeClangdConfigIfAbsent', () => {
  it('writes the file when it does not exist and returns true', () => {
    const root = makeTempRoot()
    const written = writeClangdConfigIfAbsent(root, buildClangdConfigForClangCl())
    expect(written).toBe(true)
    const path = join(root, CLANGD_CONFIG_FILENAME)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(buildClangdConfigForClangCl())
  })

  it('never overwrites a user config that already exists (write-once)', () => {
    const root = makeTempRoot()
    const path = join(root, CLANGD_CONFIG_FILENAME)
    const userContent = '# my own clangd\nCompileFlags:\n  Add: [-Wno-foo]\n'
    writeFileSync(path, userContent)

    const written = writeClangdConfigIfAbsent(root, buildClangdConfigForClangCl())
    expect(written).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(userContent)
  })

  it('does not rewrite an Orca-generated config from a prior run (write-once)', () => {
    const root = makeTempRoot()
    writeClangdConfigIfAbsent(root, buildClangdConfigForClangCl())
    // A later degraded state must not replace the clang-cl config.
    const written = writeClangdConfigIfAbsent(root, buildClangdConfigDegradedTemplate())
    expect(written).toBe(false)
    const path = join(root, CLANGD_CONFIG_FILENAME)
    expect(readFileSync(path, 'utf8')).toBe(buildClangdConfigForClangCl())
  })
})

describe('compileCommandsUsesClangCl', () => {
  it('detects a native MSVC cl.exe as arguments[0] basename', () => {
    const entries: CompileCommandEntry[] = [
      {
        directory: 'C:/proj',
        file: 'C:/proj/a.cpp',
        arguments: [
          'C:\\Program Files\\Microsoft Visual Studio\\2022\\VC\\Tools\\MSVC\\14.44\\bin\\Hostx64\\x64\\cl.exe',
          '/c',
          'a.cpp'
        ]
      }
    ]
    expect(compileCommandsUsesClangCl(entries)).toBe(true)
  })

  it('detects a backslash-separated cl.exe path', () => {
    const entries: CompileCommandEntry[] = [
      { directory: '/proj', file: '/proj/a.cpp', arguments: ['\\cl.exe', 'a.cpp'] }
    ]
    expect(compileCommandsUsesClangCl(entries)).toBe(true)
  })

  it('detects a command-string form (split first token) cl.exe', () => {
    const entries: CompileCommandEntry[] = [
      { directory: '/proj', file: '/proj/a.cpp', command: 'cl.exe /c a.cpp' }
    ]
    expect(compileCommandsUsesClangCl(entries)).toBe(true)
  })

  it('does not flag clang-cl.exe (basename differs from cl.exe)', () => {
    const entries: CompileCommandEntry[] = [
      {
        directory: '/proj',
        file: '/proj/a.cpp',
        arguments: ['/usr/bin/clang-cl.exe', '-c', 'a.cpp']
      }
    ]
    expect(compileCommandsUsesClangCl(entries)).toBe(false)
  })

  it('does not flag clang++ or gcc', () => {
    const entries: CompileCommandEntry[] = [
      { directory: '/proj', file: '/proj/a.cpp', arguments: ['/usr/bin/clang++', '-c', 'a.cpp'] },
      { directory: '/proj', file: '/proj/b.cpp', command: 'gcc -c b.cpp' }
    ]
    expect(compileCommandsUsesClangCl(entries)).toBe(false)
  })

  it('returns false for an empty db', () => {
    expect(compileCommandsUsesClangCl([])).toBe(false)
  })
})
