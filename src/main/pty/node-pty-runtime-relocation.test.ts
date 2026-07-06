import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/unused'),
    getVersion: vi.fn(() => '0.0.0-test')
  }
}))

import { ensureRelocatedRuntime } from './install-dir-runtime-relocation'
import { resolveNodePtyNativeSourceDir } from './node-pty-runtime-relocation'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), 'node-pty-relocation-'))
})

afterEach(() => {
  // Why: the loader-override test dlopens conpty.node from tempDir, and a
  // loaded native module stays image-locked until the process exits.
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {}
})

describe('resolveNodePtyNativeSourceDir', () => {
  it('prefers the rebuilt build/Release binding over prebuilds', () => {
    const pkg = join(tempDir, 'node-pty')
    mkdirSync(join(pkg, 'build', 'Release'), { recursive: true })
    mkdirSync(join(pkg, 'prebuilds', `win32-${process.arch}`), { recursive: true })
    writeFileSync(join(pkg, 'build', 'Release', 'conpty.node'), 'x')
    writeFileSync(join(pkg, 'prebuilds', `win32-${process.arch}`, 'conpty.node'), 'x')
    expect(resolveNodePtyNativeSourceDir(pkg)).toBe(join(pkg, 'build', 'Release'))
  })

  it('falls back to the platform prebuild dir', () => {
    const pkg = join(tempDir, 'node-pty')
    mkdirSync(join(pkg, 'prebuilds', `win32-${process.arch}`), { recursive: true })
    writeFileSync(join(pkg, 'prebuilds', `win32-${process.arch}`, 'conpty.node'), 'x')
    expect(resolveNodePtyNativeSourceDir(pkg)).toBe(join(pkg, 'prebuilds', `win32-${process.arch}`))
  })

  it('returns null when no conpty binding exists', () => {
    const pkg = join(tempDir, 'node-pty')
    mkdirSync(join(pkg, 'build', 'Release'), { recursive: true })
    expect(resolveNodePtyNativeSourceDir(pkg)).toBeNull()
  })
})

// Loads the real win32 conpty binding, so it cannot run on other platforms.
describe.runIf(process.platform === 'win32')('patched node-pty loader override', () => {
  it('loads the conpty binding from ORCA_NODE_PTY_NATIVE_DIR', () => {
    const requireFromHere = createRequire(import.meta.url)
    const nodePtyPackageDir = dirname(requireFromHere.resolve('node-pty/package.json'))
    const sourceDir = resolveNodePtyNativeSourceDir(nodePtyPackageDir)
    expect(sourceDir).not.toBeNull()

    const destDir = ensureRelocatedRuntime({
      sourceDir: sourceDir!,
      destRoot: join(tempDir, 'relocated-runtime'),
      version: 'loader-test',
      daemonRuntimeDir: join(tempDir, 'daemon')
    })
    expect(destDir).not.toBeNull()

    const previousNativeDir = process.env.ORCA_NODE_PTY_NATIVE_DIR
    process.env.ORCA_NODE_PTY_NATIVE_DIR = destDir!
    try {
      const utils = requireFromHere('node-pty/lib/utils.js')
      const loaded = utils.loadNativeModule('conpty')
      expect(loaded.dir).toBe(destDir)
      expect(typeof loaded.module.startProcess).toBe('function')
    } finally {
      if (previousNativeDir === undefined) {
        delete process.env.ORCA_NODE_PTY_NATIVE_DIR
      } else {
        process.env.ORCA_NODE_PTY_NATIVE_DIR = previousNativeDir
      }
    }
  })
})
