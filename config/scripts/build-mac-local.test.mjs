import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalBuildVersion, removeUnpackedMacApps } from './build-mac-local.mjs'

describe('createLocalBuildVersion', () => {
  it('creates unique valid prerelease versions without changing the release base', () => {
    expect(createLocalBuildVersion('1.4.159-rc.0', 123456, 'abc123')).toBe(
      '1.4.159-rc.0.local.123456.abc123'
    )
    expect(createLocalBuildVersion('1.4.159', 123456, 'abc123')).toBe('1.4.159-local.123456.abc123')
  })

  it('sanitizes commit identifiers', () => {
    expect(createLocalBuildVersion('1.0.0', 1, 'abc/def')).toBe('1.0.0-local.1.abcdef')
  })
})

describe('removeUnpackedMacApps', () => {
  it('removes unpacked apps but keeps distributable artifacts', () => {
    const output = mkdtempSync(join(tmpdir(), 'orca-mac-build-output-'))
    try {
      mkdirSync(join(output, 'mac', 'Orca.app'), { recursive: true })
      mkdirSync(join(output, 'mac-arm64', 'Orca.app'), { recursive: true })
      const dmg = join(output, 'orca-macos-arm64.dmg')
      writeFileSync(dmg, 'installer')

      removeUnpackedMacApps(output)

      expect(existsSync(dmg)).toBe(true)
      expect(existsSync(join(output, 'mac', 'Orca.app'))).toBe(false)
      expect(existsSync(join(output, 'mac-arm64', 'Orca.app'))).toBe(false)
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
