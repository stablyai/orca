import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  assertPackagedDaemonEntryExists,
  verifyPackagedDaemonEntryBoots: verifyBoot
} = require('./verify-packaged-daemon-entry.cjs')

describe('verify-packaged-daemon-entry', () => {
  let resourcesDir

  beforeEach(() => {
    resourcesDir = mkdtempSync(join(tmpdir(), 'orca-daemon-entry-verify-'))
  })

  afterEach(() => {
    rmSync(resourcesDir, { recursive: true, force: true })
  })

  const verifyPackagedDaemonEntryBoots = (directory) =>
    verifyBoot(directory, { execPath: process.execPath, platform: 'linux' })

  function writePackagedEntry(source) {
    const entryDir = join(resourcesDir, 'terminal-daemon')
    mkdirSync(entryDir, { recursive: true })
    writeFileSync(join(entryDir, 'daemon-entry.js'), source)
  }

  // Why: a silent skip on a missing entry false-passed exactly the packaged
  // layout regression this gate exists to catch (rc.1 daemon-load incident).
  it('throws when the unpacked daemon entry is missing', () => {
    expect(() => assertPackagedDaemonEntryExists(resourcesDir, 'linux')).toThrow(
      /missing terminal daemon entry/
    )
    expect(() => verifyPackagedDaemonEntryBoots(resourcesDir)).toThrow(
      /missing terminal daemon entry/
    )
  })

  it('requires the Windows gate even when the daemon entry exists', () => {
    writePackagedEntry('process.exit(0)')
    expect(() => assertPackagedDaemonEntryExists(resourcesDir, 'win32')).toThrow(
      /missing Windows Bun PTY gate/
    )
    writeFileSync(join(resourcesDir, 'terminal-daemon', 'windows-bun-pty-gate-entry.js'), '')
    expect(() => assertPackagedDaemonEntryExists(resourcesDir, 'win32')).not.toThrow()
  })

  it('fails when the packaged Bun runtime is absent', () => {
    writePackagedEntry('console.error("Usage: daemon-entry"); process.exit(1)')
    expect(() => verifyBoot(resourcesDir, { platform: 'linux' })).toThrow(/could not launch/)
  })

  it('passes when the packaged entry loads and reaches argv parsing', () => {
    writePackagedEntry('console.error("Usage: daemon-entry <socket>"); process.exit(1)\n')
    expect(() => verifyPackagedDaemonEntryBoots(resourcesDir)).not.toThrow()
  })

  it('fails when the packaged entry cannot resolve its module graph', () => {
    writePackagedEntry('require("orca-module-that-does-not-exist")\n')
    expect(() => verifyPackagedDaemonEntryBoots(resourcesDir)).toThrow(
      /failed to load under bundled Bun/
    )
  })

  it('fails when the packaged entry never reaches argv parsing', () => {
    writePackagedEntry('process.exit(0)\n')
    expect(() => verifyPackagedDaemonEntryBoots(resourcesDir)).toThrow(/did not reach argv parsing/)
  })
})
