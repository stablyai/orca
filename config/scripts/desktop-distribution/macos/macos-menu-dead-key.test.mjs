import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { buildMacNativeAddon } = require('./build-macos-native-addon.cjs')
const macOS27 =
  process.platform === 'darwin' &&
  Number(
    execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).split('.')[0]
  ) >= 27

describe.skipIf(!macOS27)('macOS dead-key menu routing', () => {
  it('passes empty numeric-pad dead keys back to input while retaining native shortcuts', () => {
    const work = mkdtempSync(join(tmpdir(), 'orca-menu-dead-key-'))
    const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    try {
      const probe = join(work, 'probe')
      execFileSync('/usr/bin/clang', [
        '-fobjc-arc',
        '-framework',
        'AppKit',
        resolve(
          import.meta.dirname,
          '../../../../native/macos-menu-dead-key/probe-menu-dead-key.m'
        ),
        '-o',
        probe
      ])
      const baseline = spawnSync(probe, [], { env, encoding: 'utf8', timeout: 10_000 })
      expect(baseline.status).toBe(42)
      expect(baseline.stderr).toContain('characterAtIndex:')
      for (const arch of ['x64', 'arm64']) {
        buildMacNativeAddon(
          join(work, arch),
          arch,
          'macos-menu-dead-key',
          'orca_menu_dead_key.node'
        )
      }
      expect(
        execFileSync(probe, [join(work, process.arch, 'orca_menu_dead_key.node')], {
          env,
          encoding: 'utf8',
          timeout: 10_000
        }).trim()
      ).toBe('dead keys passed through; Command+C and keypad shortcut delivered')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }, 90_000)
})
