import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { buildMacNativeAddon } = require('./build-macos-native-addon.cjs')

describe.skipIf(process.platform !== 'darwin')('macOS memory status reader', () => {
  it('builds for both Mac architectures and reads the same free percentage memory_pressure prints', () => {
    const work = mkdtempSync(join(tmpdir(), 'orca-memory-status-'))
    try {
      for (const arch of ['x64', 'arm64']) {
        buildMacNativeAddon(
          join(work, arch),
          arch,
          'macos-memory-status',
          'orca_memory_status.node'
        )
      }
      const addon = require(join(work, process.arch, 'orca_memory_status.node'))
      const free = addon.freePercent()
      const reported = Number(
        /System-wide memory free percentage:\s*(\d+)%/.exec(
          execFileSync('/usr/bin/memory_pressure', ['-Q'], { encoding: 'utf8' })
        )?.[1]
      )
      expect(Number.isInteger(free)).toBe(true)
      // Both read kern.memorystatus_level; allow for movement between the two reads.
      expect(Math.abs(free - reported)).toBeLessThanOrEqual(10)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }, 90_000)
})
