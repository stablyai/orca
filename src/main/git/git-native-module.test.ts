import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

import { track } from '../telemetry/client'
import { loadGitNativeModule, resetGitNativeModuleForTests } from './git-native-module'

const builtArtifact = path.join(process.cwd(), 'native', 'git-native', '.build', 'git-native.node')

afterEach(() => {
  resetGitNativeModuleForTests()
  delete process.env.ORCA_GIT_NATIVE_PATH
  vi.clearAllMocks()
})

describe('loadGitNativeModule', () => {
  it('returns null without emitting telemetry when no artifact exists anywhere', () => {
    process.env.ORCA_GIT_NATIVE_PATH = path.join(process.cwd(), 'does-not-exist.node')
    expect(loadGitNativeModule()).toBeNull()
    expect(track).not.toHaveBeenCalled()
  })

  it('caches a negative result without re-resolving or re-loading', () => {
    process.env.ORCA_GIT_NATIVE_PATH = path.join(process.cwd(), 'does-not-exist.node')
    expect(loadGitNativeModule()).toBeNull()
    // Repoint at a loadable file: if resolution or load re-ran, require()
    // would succeed and the missing probe would emit load_error telemetry.
    process.env.ORCA_GIT_NATIVE_PATH = path.join(process.cwd(), 'package.json')
    expect(loadGitNativeModule()).toBeNull()
    expect(track).not.toHaveBeenCalled()
  })

  it.skipIf(!existsSync(builtArtifact))('loads and health-checks the built artifact', () => {
    process.env.ORCA_GIT_NATIVE_PATH = builtArtifact
    const module = loadGitNativeModule()
    expect(module).not.toBeNull()
    expect(module!.nativeGitPing()).toBe(1)
  })

  it('emits load_error telemetry when the artifact loads but lacks the probe', () => {
    // require() parses .json natively, so this exercises the thrown-TypeError
    // path (calling the missing nativeGitPing), not a dlopen failure.
    process.env.ORCA_GIT_NATIVE_PATH = path.join(process.cwd(), 'package.json')
    expect(loadGitNativeModule()).toBeNull()
    expect(track).toHaveBeenCalledWith('git_native_load_failed', { error_class: 'load_error' })
  })

  it('emits load_error telemetry when dlopen rejects the artifact', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'git-native-module-test-'))
    try {
      const garbage = path.join(dir, 'garbage.node')
      writeFileSync(garbage, 'not a native addon')
      process.env.ORCA_GIT_NATIVE_PATH = garbage
      expect(loadGitNativeModule()).toBeNull()
      expect(track).toHaveBeenCalledWith('git_native_load_failed', { error_class: 'load_error' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('emits ping_mismatch telemetry when the probe returns the wrong value', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'git-native-module-test-'))
    try {
      const fixture = path.join(dir, 'ping-mismatch.js')
      writeFileSync(fixture, 'module.exports = { nativeGitPing: () => 2 }\n')
      process.env.ORCA_GIT_NATIVE_PATH = fixture
      expect(loadGitNativeModule()).toBeNull()
      expect(track).toHaveBeenCalledWith('git_native_load_failed', { error_class: 'ping_mismatch' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
