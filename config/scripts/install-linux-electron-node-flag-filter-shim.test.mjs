import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHROMIUM_ONLY_ELECTRON_FLAGS,
  buildLinuxElectronNodeFlagFilterShim,
  installLinuxElectronNodeFlagFilterShim,
  stripChromiumOnlyFlagsForNodeMode
} from './install-linux-electron-node-flag-filter-shim.cjs'

const tempDirs = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-linux-shim-'))
  tempDirs.push(dir)
  return dir
}

describe('stripChromiumOnlyFlagsForNodeMode', () => {
  it('removes --no-sandbox and related Chromium flags (issue #11609)', () => {
    expect(
      stripChromiumOnlyFlagsForNodeMode(['--no-sandbox', '-e', 'console.log(1)', '--', 'status'])
    ).toEqual(['-e', 'console.log(1)', '--', 'status'])
  })

  it('preserves unrelated flags and empty input', () => {
    expect(stripChromiumOnlyFlagsForNodeMode(['--inspect', 'app.js'])).toEqual([
      '--inspect',
      'app.js'
    ])
    expect(stripChromiumOnlyFlagsForNodeMode([])).toEqual([])
  })

  it('does not mutate the input array', () => {
    const input = ['--no-sandbox', '-e', 'x']
    const output = stripChromiumOnlyFlagsForNodeMode(input)
    expect(output).toEqual(['-e', 'x'])
    expect(input).toEqual(['--no-sandbox', '-e', 'x'])
  })
})

describe('buildLinuxElectronNodeFlagFilterShim', () => {
  it('derives the bash case pattern from CHROMIUM_ONLY_ELECTRON_FLAGS', () => {
    const shim = buildLinuxElectronNodeFlagFilterShim('orca-ide.bin')
    expect(shim.startsWith('#!/usr/bin/env bash')).toBe(true)
    expect(shim).toContain('orca-ide.bin')
    expect(shim).toContain('ELECTRON_RUN_AS_NODE')
    expect(shim).toContain('readlink -f')
    for (const flag of CHROMIUM_ONLY_ELECTRON_FLAGS) {
      expect(shim).toContain(flag)
    }
    expect(shim).toContain(CHROMIUM_ONLY_ELECTRON_FLAGS.join('|'))
  })
})

describe('installLinuxElectronNodeFlagFilterShim', () => {
  it('renames the real binary and installs a Node-mode flag filter (issue #11609)', () => {
    const dir = makeDir()
    const binaryPath = join(dir, 'orca-ide')
    writeFileSync(binaryPath, '#!/bin/sh\necho real\n', 'utf8')
    chmodSync(binaryPath, 0o755)

    const result = installLinuxElectronNodeFlagFilterShim(dir, 'orca-ide')
    expect(existsSync(result.realPath)).toBe(true)
    expect(existsSync(result.binaryPath)).toBe(true)
    expect(existsSync(join(dir, 'orca-ide.shim.tmp'))).toBe(false)
    const shim = readFileSync(result.binaryPath, 'utf8')
    expect(shim).toContain('orca-ide.bin')
    expect(shim).toContain('--no-sandbox')
    expect(readFileSync(result.realPath, 'utf8')).toContain('echo real')
  })

  it('recovers when orca-ide.bin exists but the public name is missing', () => {
    const dir = makeDir()
    const realPath = join(dir, 'orca-ide.bin')
    writeFileSync(realPath, '#!/bin/sh\necho recovered\n', 'utf8')
    chmodSync(realPath, 0o755)

    const result = installLinuxElectronNodeFlagFilterShim(dir, 'orca-ide')
    expect(result.recovered).toBe(true)
    expect(existsSync(result.binaryPath)).toBe(true)
    expect(readFileSync(result.binaryPath, 'utf8')).toContain('ELECTRON_RUN_AS_NODE')
  })

  it('is idempotent when the shim is already installed', () => {
    const dir = makeDir()
    const binaryPath = join(dir, 'orca-ide')
    writeFileSync(binaryPath, '#!/bin/sh\necho real\n', 'utf8')
    chmodSync(binaryPath, 0o755)
    installLinuxElectronNodeFlagFilterShim(dir, 'orca-ide')
    const firstShim = readFileSync(binaryPath, 'utf8')

    installLinuxElectronNodeFlagFilterShim(dir, 'orca-ide')
    expect(readFileSync(binaryPath, 'utf8')).toBe(firstShim)
    expect(existsSync(join(dir, 'orca-ide.bin'))).toBe(true)
  })
})
