import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import {
  buildLinuxElectronNodeFlagFilterShim,
  installLinuxElectronNodeFlagFilterShim
} from './install-linux-electron-node-flag-filter-shim.cjs'

const tempDirs = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('installLinuxElectronNodeFlagFilterShim', () => {
  it('renames the real binary and installs a Node-mode flag filter (issue #11609)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-linux-shim-'))
    tempDirs.push(dir)
    const binaryPath = join(dir, 'orca-ide')
    writeFileSync(binaryPath, '#!/bin/sh\necho real\n', 'utf8')
    chmodSync(binaryPath, 0o755)

    const result = installLinuxElectronNodeFlagFilterShim(dir, 'orca-ide')
    expect(existsSync(result.realPath)).toBe(true)
    expect(existsSync(result.binaryPath)).toBe(true)
    const shim = readFileSync(result.binaryPath, 'utf8')
    expect(shim).toContain('orca-ide.bin')
    expect(shim).toContain('--no-sandbox')
    expect(shim).toContain('ELECTRON_RUN_AS_NODE')
  })
})

describe('buildLinuxElectronNodeFlagFilterShim', () => {
  it('mentions the real binary basename', () => {
    expect(buildLinuxElectronNodeFlagFilterShim('orca-ide.bin')).toContain('orca-ide.bin')
  })
})
