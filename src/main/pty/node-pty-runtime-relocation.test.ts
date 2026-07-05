import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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

import {
  ensureRelocatedNodePtyNativeRuntime,
  resolveNodePtyNativeSourceDir
} from './node-pty-runtime-relocation'

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

function seedSourceDir(dir: string): void {
  mkdirSync(join(dir, 'conpty'), { recursive: true })
  writeFileSync(join(dir, 'conpty.node'), 'binding')
  writeFileSync(join(dir, 'conpty_console_list.node'), 'listing')
  writeFileSync(join(dir, 'pty.node'), 'winpty-binding')
  writeFileSync(join(dir, 'winpty-agent.exe'), 'agent')
  writeFileSync(join(dir, 'conpty.pdb'), 'symbols')
  writeFileSync(join(dir, 'conpty', 'conpty.dll'), 'dll')
  writeFileSync(join(dir, 'conpty', 'OpenConsole.exe'), 'console-host')
}

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

describe('ensureRelocatedNodePtyNativeRuntime', () => {
  it('copies the runtime tree (without symbols) and returns the version dir', () => {
    const sourceDir = join(tempDir, 'source')
    seedSourceDir(sourceDir)
    const destRoot = join(tempDir, 'dest')

    const destDir = ensureRelocatedNodePtyNativeRuntime({ sourceDir, destRoot, version: '1.2.3' })

    expect(destDir).toBe(join(destRoot, '1.2.3'))
    expect(readFileSync(join(destDir!, 'conpty.node'), 'utf8')).toBe('binding')
    expect(readFileSync(join(destDir!, 'conpty', 'OpenConsole.exe'), 'utf8')).toBe('console-host')
    expect(readFileSync(join(destDir!, 'conpty', 'conpty.dll'), 'utf8')).toBe('dll')
    expect(existsSync(join(destDir!, 'conpty.pdb'))).toBe(false)
  })

  it('skips recopying once the completion marker exists', () => {
    const sourceDir = join(tempDir, 'source')
    seedSourceDir(sourceDir)
    const destRoot = join(tempDir, 'dest')
    ensureRelocatedNodePtyNativeRuntime({ sourceDir, destRoot, version: '1.2.3' })

    writeFileSync(join(sourceDir, 'conpty.node'), 'changed-after-first-copy')
    const destDir = ensureRelocatedNodePtyNativeRuntime({ sourceDir, destRoot, version: '1.2.3' })

    expect(readFileSync(join(destDir!, 'conpty.node'), 'utf8')).toBe('binding')
  })

  it('redoes an interrupted copy that has no completion marker', () => {
    const sourceDir = join(tempDir, 'source')
    seedSourceDir(sourceDir)
    const destRoot = join(tempDir, 'dest')
    mkdirSync(join(destRoot, '1.2.3'), { recursive: true })
    writeFileSync(join(destRoot, '1.2.3', 'conpty.node'), 'torn partial copy')

    const destDir = ensureRelocatedNodePtyNativeRuntime({ sourceDir, destRoot, version: '1.2.3' })

    expect(readFileSync(join(destDir!, 'conpty.node'), 'utf8')).toBe('binding')
  })

  it('removes stale version dirs but keeps the current one', () => {
    const sourceDir = join(tempDir, 'source')
    seedSourceDir(sourceDir)
    const destRoot = join(tempDir, 'dest')
    ensureRelocatedNodePtyNativeRuntime({ sourceDir, destRoot, version: '1.0.0' })

    const destDir = ensureRelocatedNodePtyNativeRuntime({ sourceDir, destRoot, version: '2.0.0' })

    expect(destDir).toBe(join(destRoot, '2.0.0'))
    expect(existsSync(join(destRoot, '1.0.0'))).toBe(false)
    expect(existsSync(join(destRoot, '2.0.0', 'conpty.node'))).toBe(true)
  })

  it('fails open when the source dir is missing', () => {
    expect(
      ensureRelocatedNodePtyNativeRuntime({
        sourceDir: join(tempDir, 'does-not-exist'),
        destRoot: join(tempDir, 'dest'),
        version: '1.2.3'
      })
    ).toBeNull()
  })
})

// Loads the real win32 conpty binding, so it cannot run on other platforms.
describe.runIf(process.platform === 'win32')('patched node-pty loader override', () => {
  it('loads the conpty binding from ORCA_NODE_PTY_NATIVE_DIR', () => {
    const requireFromHere = createRequire(import.meta.url)
    const nodePtyPackageDir = dirname(requireFromHere.resolve('node-pty/package.json'))
    const sourceDir = resolveNodePtyNativeSourceDir(nodePtyPackageDir)
    expect(sourceDir).not.toBeNull()

    const destDir = ensureRelocatedNodePtyNativeRuntime({
      sourceDir: sourceDir!,
      destRoot: join(tempDir, 'relocated-runtime'),
      version: 'loader-test'
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
