import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeGuestTreeKillArtifactsFixture } from '../../shared/guest-tree-kill-artifacts-test-fixture'
const state = vi.hoisted(() => ({ present: true, packaged: false, appPath: '' }))
vi.mock('../../shared/app-environment', () => ({
  hasAppEnvironment: () => state.present,
  getAppEnvironment: () => ({ isPackaged: () => state.packaged, getAppPath: () => state.appPath })
}))
import { resolveBundledGuestTreeKillArtifact } from './bundled-guest-tree-kill'

const originalResources = process.resourcesPath
const originalArgv = process.argv
const scratch: string[] = []
afterEach(() => {
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: originalResources })
  process.argv = originalArgv
  state.present = true
  state.packaged = false
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-bundled-guest-'))
  scratch.push(root)
  state.appPath = root
  writeGuestTreeKillArtifactsFixture(join(root, 'resources', 'guest-tree-kill'))
  return root
}

describe('bundled guest cleanup path', () => {
  it('resolves development assets from the checkout resource tree', () => {
    const root = fixture()
    expect(resolveBundledGuestTreeKillArtifact('linux-arm64')?.path).toBe(
      join(root, 'resources', 'guest-tree-kill', 'linux-arm64', 'orca-guest-tree-kill')
    )
  })

  it('refuses a missing packaged asset rather than falling through to the checkout', () => {
    const root = fixture()
    state.packaged = true
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: join(root, 'missing-resources')
    })
    expect(resolveBundledGuestTreeKillArtifact('linux-x64')).toBeNull()
  })

  it('resolves the relocated run-as-node daemon from its own entry path without Electron globals', () => {
    const root = fixture()
    state.present = false
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: undefined })
    process.argv = [
      process.execPath,
      join(root, 'resources', 'app.asar.unpacked', 'out', 'main', 'daemon-entry.js')
    ]
    expect(resolveBundledGuestTreeKillArtifact('linux-x64')?.path).toContain(
      join(root, 'resources', 'guest-tree-kill')
    )
  })

  it.each(['', 'daemon-entry.js', 'out/main/daemon-entry.js'])(
    'refuses an untrusted relative or missing entry %p',
    (entry) => {
      fixture()
      state.present = false
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: undefined })
      process.argv = entry ? [process.execPath, entry] : [process.execPath]
      expect(resolveBundledGuestTreeKillArtifact('linux-x64')).toBeNull()
    }
  )

  it('uses the trusted resource root instead of resolving a relative daemon entry through cwd', () => {
    const root = fixture()
    state.present = false
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: join(root, 'resources')
    })
    process.argv = [process.execPath, 'relative/out/main/daemon-entry.js']
    expect(resolveBundledGuestTreeKillArtifact('linux-x64')?.path).toBe(
      join(root, 'resources', 'guest-tree-kill', 'linux-x64', 'orca-guest-tree-kill')
    )
  })

  it('resolves a plain orcad daemon beside its entry, without a working-directory fallback', () => {
    const root = fixture()
    state.present = false
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: undefined })
    writeGuestTreeKillArtifactsFixture(join(root, 'guest-tree-kill'))
    process.argv = [process.execPath, join(root, 'daemon-entry.js')]
    expect(resolveBundledGuestTreeKillArtifact('linux-x64')?.path).toBe(
      join(root, 'guest-tree-kill', 'linux-x64', 'orca-guest-tree-kill')
    )
  })
})
