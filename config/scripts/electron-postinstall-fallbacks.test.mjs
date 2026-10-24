import { describe, expect, it } from 'vitest'
import {
  describeMissingElectronLibrary,
  findMissingElectronLibrary,
  parseMissingSharedLibrary
} from './electron-postinstall-fallbacks.mjs'

const LOADER_ERROR =
  '/repo/node_modules/electron/dist/electron: error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file: No such file or directory\n'

describe('findMissingElectronLibrary', () => {
  it('names the library the dynamic loader could not find', () => {
    const run = () => ({ status: 127, stdout: '', stderr: LOADER_ERROR })
    expect(findMissingElectronLibrary('/electron', { run })).toBe('libatk-1.0.so.0')
  })

  it('returns null when Electron starts', () => {
    const run = () => ({ status: 0, stdout: '', stderr: '' })
    expect(findMissingElectronLibrary('/electron', { run })).toBeNull()
  })

  // Why: any other failure is a real problem the addon probe should still report.
  it('returns null when Electron fails for another reason', () => {
    const run = () => ({ status: 1, stdout: '', stderr: 'Segmentation fault\n' })
    expect(findMissingElectronLibrary('/electron', { run })).toBeNull()
    const spawnError = () => ({ status: null, error: new Error('ENOENT'), stdout: '', stderr: '' })
    expect(findMissingElectronLibrary('/electron', { run: spawnError })).toBeNull()
  })

  it('runs Electron as Node so no window or display is needed', () => {
    let seen
    const run = (program, args, options) => {
      seen = { program, args, runAsNode: options.env.ELECTRON_RUN_AS_NODE }
      return { status: 0, stdout: '', stderr: '' }
    }
    findMissingElectronLibrary('/electron', { run })
    expect(seen).toEqual({ program: '/electron', args: ['-e', ''], runAsNode: '1' })
  })
})

describe('parseMissingSharedLibrary', () => {
  it('ignores output without a loader error', () => {
    expect(parseMissingSharedLibrary('Error: Cannot find module node-pty')).toBeNull()
  })
})

describe('describeMissingElectronLibrary', () => {
  it('names the library and the packages to install', () => {
    const message = describeMissingElectronLibrary('libatk-1.0.so.0')
    expect(message).toContain('libatk-1.0.so.0 is missing')
    expect(message).toContain('sudo apt-get install -y libgtk-3-0t64 libatk1.0-0t64')
    // The loader reports one library per run, so the hint must cover the rest, e.g. NSS.
    expect(message).toContain(' libnss3 libgbm1`')
  })
})
