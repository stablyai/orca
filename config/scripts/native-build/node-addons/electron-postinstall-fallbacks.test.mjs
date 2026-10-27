import { describe, expect, it } from 'vitest'
import { findMissingElectronLibrary } from './electron-postinstall-fallbacks.mjs'

describe('findMissingElectronLibrary', () => {
  // Why: any other failure is a real problem the addon probe should still report.
  it('returns null when Electron fails for another reason', () => {
    const run = () => ({ status: 1, stdout: '', stderr: 'Segmentation fault\n' })
    expect(findMissingElectronLibrary('/electron', { run })).toBeNull()
    const spawnError = () => ({ status: null, error: new Error('ENOENT'), stdout: '', stderr: '' })
    expect(findMissingElectronLibrary('/electron', { run: spawnError })).toBeNull()
  })
})
