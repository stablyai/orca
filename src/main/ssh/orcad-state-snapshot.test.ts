import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ORCAD_SNAPSHOT_EXCLUDED,
  ORCAD_SNAPSHOT_MEMBERS,
  captureOrcadStateSnapshotCommand,
  clearOrcadStateSnapshotMembersCommand,
  newestStateMtimeCommand,
  orcadRollbackRescueDirName,
  orcadSnapshotDirName,
  parseNewestStateMtimeSeconds,
  parseOrcadSnapshotCapture,
  parseOrcadSnapshotPresence,
  parseOrcadSnapshotRestore,
  restoreOrcadStateSnapshotCommand
} from './orcad-state-snapshot'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')
const ROOT = '/home/u/.orca'
const SNAP = '/home/u/.orca-remote/orcad-state-snapshots/pre-0.2.0+bb01-1000'

function decodePowerShellCommand(command: string): string {
  const encoded = command.trim().split(/\s+/).at(-1) ?? ''
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('capturing the pre-activation snapshot', () => {
  it('captures the profile state a rollback needs', () => {
    const command = captureOrcadStateSnapshotCommand(posix, ROOT, SNAP)
    for (const member of ORCAD_SNAPSHOT_MEMBERS) {
      expect(command).toContain(`'${member}'`)
    }
  })

  // The live daemon owns <root>/daemon and outlives every restart. Restoring a stale copy of
  // its socket, PID record and token would break the fence that keeps its terminals adoptable.
  it.each(ORCAD_SNAPSHOT_EXCLUDED)('never captures %s', (excluded) => {
    expect(captureOrcadStateSnapshotCommand(posix, ROOT, SNAP)).not.toContain(`'${excluded}'`)
  })

  it.each(ORCAD_SNAPSHOT_EXCLUDED)('never removes or restores over %s', (excluded) => {
    expect(restoreOrcadStateSnapshotCommand(posix, ROOT, SNAP)).not.toContain(`'${excluded}'`)
  })

  it('writes the archive under a temp name and renames, so a killed deploy leaves no torn tar', () => {
    const command = captureOrcadStateSnapshotCommand(posix, ROOT, SNAP)
    expect(command).toContain('.partial')
    expect(command.indexOf('umask 077')).toBeLessThan(command.indexOf('mkdir -p'))
    expect(command.indexOf('tar -C')).toBeLessThan(command.indexOf('mv '))
  })

  it.each([
    ['CAPTURED', 'captured'],
    ['EMPTY', 'empty'],
    ['tar: broken', 'failed'],
    ['', 'failed']
  ])('parses %s as %s', (output, expected) => {
    expect(parseOrcadSnapshotCapture(output)).toBe(expected)
  })

  it('keys the snapshot dir on both version and time, so a retry cannot overwrite one', () => {
    expect(orcadSnapshotDirName('0.2.0+bb01', 1000)).not.toBe(
      orcadSnapshotDirName('0.2.0+bb01', 2000)
    )
  })

  it('gives each pre-rollback rescue its own durable directory', () => {
    expect(orcadRollbackRescueDirName('0.2.0+bb01', 1000)).not.toBe(
      orcadRollbackRescueDirName('0.2.0+bb01', 2000)
    )
  })
})

describe('restoring the snapshot', () => {
  it.each([
    ['PRESENT', 'present'],
    ['ABSENT', 'absent'],
    ['', 'unverifiable'],
    ['ssh: disconnected', 'unverifiable']
  ])('parses snapshot presence %s as %s', (output, expected) => {
    expect(parseOrcadSnapshotPresence(output)).toBe(expected)
  })

  it('extracts every archived byte before removing live state, then replaces covered members', () => {
    const command = restoreOrcadStateSnapshotCommand(posix, ROOT, SNAP)
    expect(command.indexOf('umask 077')).toBeLessThan(command.indexOf('mkdir -p'))
    expect(command.indexOf('tar -C')).toBeLessThan(command.indexOf("rm -rf '/home/u/.orca'"))
    expect(command).toContain('.orcad-state-restore-stage')
    expect(command).toContain('then mv ')
  })

  it('can restore a pre-activation root that was empty', () => {
    const command = clearOrcadStateSnapshotMembersCommand(posix, ROOT)
    expect(command.indexOf('umask 077')).toBeLessThan(command.indexOf('mkdir -p'))
    for (const member of ORCAD_SNAPSHOT_MEMBERS) {
      expect(command).toContain(`'${member}'`)
    }
    expect(command).not.toContain("'daemon'")
    expect(command).toContain('echo RESTORED')
  })

  it('reports a missing archive instead of extracting nothing and claiming success', () => {
    expect(restoreOrcadStateSnapshotCommand(posix, ROOT, SNAP)).toContain('echo MISSING')
    expect(parseOrcadSnapshotRestore('MISSING')).toBe('missing')
    expect(parseOrcadSnapshotRestore('RESTORED')).toBe('restored')
    expect(parseOrcadSnapshotRestore('FAILED')).toBe('failed')
  })

  it.runIf(process.platform !== 'win32')(
    'does not touch live state when the archive cannot be fully extracted',
    () => {
      const testRoot = mkdtempSync(join(tmpdir(), 'orcad-restore-stage-'))
      const userDataDir = join(testRoot, 'data')
      const snapshotDir = join(testRoot, 'snapshot')
      try {
        mkdirSync(userDataDir)
        mkdirSync(snapshotDir)
        writeFileSync(join(userDataDir, 'orca-data.json'), 'current-state')
        writeFileSync(join(snapshotDir, 'state.tar'), 'not a tar archive')

        const output = execFileSync(
          '/bin/sh',
          ['-c', restoreOrcadStateSnapshotCommand(posix, userDataDir, snapshotDir)],
          { encoding: 'utf8' }
        )

        expect(parseOrcadSnapshotRestore(output)).toBe('failed')
        expect(readFileSync(join(userDataDir, 'orca-data.json'), 'utf8')).toBe('current-state')
      } finally {
        rmSync(testRoot, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'does not erase live state when a valid archive contains no managed state members',
    () => {
      const testRoot = mkdtempSync(join(tmpdir(), 'orcad-restore-empty-'))
      const userDataDir = join(testRoot, 'data')
      const snapshotDir = join(testRoot, 'snapshot')
      try {
        mkdirSync(userDataDir)
        mkdirSync(snapshotDir)
        writeFileSync(join(userDataDir, 'orca-data.json'), 'current-state')
        execFileSync('tar', ['-cf', join(snapshotDir, 'state.tar'), '-T', '/dev/null'])

        const output = execFileSync(
          '/bin/sh',
          ['-c', restoreOrcadStateSnapshotCommand(posix, userDataDir, snapshotDir)],
          { encoding: 'utf8' }
        )

        expect(parseOrcadSnapshotRestore(output)).toBe('failed')
        expect(readFileSync(join(userDataDir, 'orca-data.json'), 'utf8')).toBe('current-state')
      } finally {
        rmSync(testRoot, { recursive: true, force: true })
      }
    }
  )
})

describe('detecting writes since activation', () => {
  it.each([
    ['1700000000', 1_700_000_000],
    ['UNKNOWN', null],
    ['', null]
  ])('parses %s', (output, expected) => {
    expect(parseNewestStateMtimeSeconds(output)).toBe(expected)
  })

  it('looks at the same members the snapshot covers', () => {
    const command = newestStateMtimeCommand(posix, ROOT)
    for (const member of ORCAD_SNAPSHOT_MEMBERS) {
      expect(command).toContain(`'${member}'`)
    }
  })
})

describe('Windows hosts', () => {
  it('captures atomically with tar.exe', () => {
    const script = decodePowerShellCommand(captureOrcadStateSnapshotCommand(windows, ROOT, SNAP))
    expect(script).toContain('& tar.exe -C $root -cf $partial @members')
    expect(script.indexOf('tar.exe')).toBeLessThan(script.indexOf('Move-Item'))
    expect(script).toContain('.partial')
  })

  it('validates into staging before replacing state and leaves daemon state unnamed', () => {
    const script = decodePowerShellCommand(restoreOrcadStateSnapshotCommand(windows, ROOT, SNAP))
    const liveStateRemoval = script.indexOf(
      "@('orca-profile-index.json'",
      script.indexOf('tar.exe')
    )
    expect(script.indexOf('tar.exe')).toBeLessThan(liveStateRemoval)
    expect(script).toContain('.orcad-state-restore-stage')
    expect(script).toContain('Move-Item -LiteralPath $source')
    expect(script).toContain('-ErrorAction Stop')
    expect(script).toContain("catch { Write-Output 'FAILED' }")
    expect(script).not.toContain("'daemon'")
  })

  it('clears candidate-created state when the pre-activation root was empty', () => {
    const script = decodePowerShellCommand(clearOrcadStateSnapshotMembersCommand(windows, ROOT))
    expect(script).toContain('Remove-Item')
    expect(script).toContain('-ErrorAction Stop')
    expect(script).not.toContain("'daemon'")
  })

  it('reads newest state timestamps through PowerShell', () => {
    const script = decodePowerShellCommand(newestStateMtimeCommand(windows, ROOT))
    expect(script).toContain('Get-ChildItem')
    expect(script).toContain('ToUnixTimeSeconds')
    for (const member of ORCAD_SNAPSHOT_MEMBERS) {
      expect(script).toContain(`'${member}'`)
    }
  })
})
