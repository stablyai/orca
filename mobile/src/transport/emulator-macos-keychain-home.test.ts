import { afterEach, describe, expect, it } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { linkEmulatorMacKeychain } from '../../scripts/emulator-macos-keychain-home.mjs'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('emulator macOS Keychain home', () => {
  it('exposes only the existing Keychain directory inside the disposable home', () => {
    const root = temporaryRoot()
    const realHome = path.join(root, 'real-home')
    const keychains = path.join(realHome, 'Library', 'Keychains')
    const disposableHome = path.join(root, 'disposable-home')
    mkdirSync(keychains, { recursive: true })

    const target = linkEmulatorMacKeychain(disposableHome, { platform: 'darwin', realHome })

    expect(target).toBe(path.join(disposableHome, 'Library', 'Keychains'))
    expect(lstatSync(target!).isSymbolicLink()).toBe(true)
    expect(readlinkSync(target!)).toBe(keychains)
  })

  it('does nothing off macOS or when the source Keychain is unavailable', () => {
    const root = temporaryRoot()

    expect(linkEmulatorMacKeychain(path.join(root, 'linux'), { platform: 'linux' })).toBeNull()
    expect(
      linkEmulatorMacKeychain(path.join(root, 'mac'), {
        platform: 'darwin',
        realHome: path.join(root, 'missing')
      })
    ).toBeNull()
  })

  it('never replaces an existing disposable-home path', () => {
    const root = temporaryRoot()
    const realHome = path.join(root, 'real-home')
    const disposableHome = path.join(root, 'disposable-home')
    mkdirSync(path.join(realHome, 'Library', 'Keychains'), { recursive: true })
    mkdirSync(path.join(disposableHome, 'Library'), { recursive: true })
    writeFileSync(path.join(disposableHome, 'Library', 'Keychains'), 'occupied')

    expect(() => linkEmulatorMacKeychain(disposableHome, { platform: 'darwin', realHome })).toThrow(
      'Refusing to replace emulator Keychain path'
    )
  })
})

function temporaryRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-emulator-keychain-test-'))
  temporaryRoots.push(root)
  return root
}
