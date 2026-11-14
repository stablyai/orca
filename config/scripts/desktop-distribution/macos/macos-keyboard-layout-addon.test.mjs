import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { buildMacNativeAddon } = require('./macos-native-addon.cjs')
const root = resolve(import.meta.dirname, '../../../..')

describe.skipIf(process.platform !== 'darwin')('native keyboard layout reader', () => {
  it('builds and reads the current layout in-process', () => {
    const work = mkdtempSync(join(tmpdir(), 'orca-keyboard-layout-'))
    try {
      const addon = require(
        buildMacNativeAddon({
          nativeDir: 'keyboard-layout-macos',
          addon: 'orca_keyboard_layout.node',
          outputDir: work,
          arch: process.arch
        })
      )
      const read = addon.read()
      expect(typeof read.snapshot.inputSourceId).toBe('string')
      expect(Object.keys(read.snapshot.keyCharacters)).toHaveLength(51)
      expect(read.keyboardType).toBe(addon.keyboardType())
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }, 90_000)

  it('keeps a supplementary-plane layout character whole', () => {
    const work = mkdtempSync(join(tmpdir(), 'orca-keyboard-layout-probe-'))
    try {
      const probe = join(work, 'probe')
      execFileSync('/usr/bin/clang', [
        '-framework',
        'Carbon',
        join(root, 'native/keyboard-layout-macos/probe-installed-layout.c'),
        '-o',
        probe
      ])
      // Osage-QWERTY ships with macOS; reading it does not enable or select it.
      expect(
        execFileSync(probe, ['com.apple.keylayout.Osage-QWERTY', 'KeyA'], { encoding: 'utf8' })
      ).toBe('D801DCD8')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }, 30_000)
})
