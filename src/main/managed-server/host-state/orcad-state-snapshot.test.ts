import { describe, expect, it } from 'vitest'

import {
  captureOrcadStateSnapshotCommand,
  clearOrcadStateSnapshotMembersCommand,
  compareOrcadStateSnapshotCommand,
  orcadSnapshotDirName,
  parseOrcadSnapshotCapture,
  parseOrcadSnapshotPresence,
  parseOrcadSnapshotRestore,
  probeOrcadStateSnapshotCommand,
  restoreOrcadStateSnapshotCommand,
  ORCAD_STATE_MUTATION_DEADLINE_SECONDS
} from './orcad-state-snapshot'
import { newestStateMtimeCommand, parseNewestStateMtimeSeconds } from './orcad-state-newest-mtime'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { ORCAD_SNAPSHOT_EXCLUDED, ORCAD_SNAPSHOT_MEMBERS } from './orcad-state-snapshot-members'

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')
const ROOT = '/home/u/.orca'
const SNAP = '/home/u/.orca-remote/orcad-state-snapshots/pre-0.2.0+bb01-1000'
const BASE = '/home/u/.orca-remote'

/** Every `for m in <members>;` list a command walks. */
function memberLists(command: string): string[] {
  return [...command.matchAll(/for m in ([^;]+);/g)].map((match) => match[1])
}

/** The work inside the lock-and-deadline wrapper, with its quoting undone. */
function innerScript(command: string): string {
  return command.replaceAll(`'\\''`, `'`)
}

describe('capturing the pre-activation snapshot', () => {
  it('captures the profile state a rollback needs', () => {
    expect(memberLists(captureOrcadStateSnapshotCommand(posix, ROOT, SNAP, BASE))).toEqual([
      ORCAD_SNAPSHOT_MEMBERS.join(' ')
    ])
  })

  // The live daemon owns <root>/daemon and outlives every restart. Restoring a stale copy of
  // its socket, PID record and token would break the fence that keeps its terminals adoptable.
  it.each(ORCAD_SNAPSHOT_EXCLUDED)('never captures, removes or restores over %s', (excluded) => {
    const commands = [
      captureOrcadStateSnapshotCommand(posix, ROOT, SNAP, BASE),
      restoreOrcadStateSnapshotCommand(posix, ROOT, SNAP, BASE),
      clearOrcadStateSnapshotMembersCommand(posix, ROOT, BASE),
      compareOrcadStateSnapshotCommand(posix, ROOT, SNAP, BASE)
    ]
    for (const list of commands.flatMap(memberLists)) {
      expect(list.split(' ')).not.toContain(excluded)
    }
  })

  it('writes the archive under a temp name and renames, so a killed deploy leaves no torn tar', () => {
    const command = captureOrcadStateSnapshotCommand(posix, ROOT, SNAP, BASE)
    expect(command).toContain('.partial')
    expect(command.indexOf('tar -C')).toBeLessThan(command.indexOf('mv '))
  })

  it.each([
    ['CAPTURED', 'captured'],
    ['EMPTY', 'empty'],
    ['tar: broken', 'failed'],
    ['', 'failed'],
    // A gateway that merges stderr into stdout appends bash's job notice after the verdict (#30491).
    ['CAPTURED\r\nsh: line 1:  2468 Terminated   ( while sleep 60 ... )\n', 'captured'],
    ['FAILED\nCAPTURED-looking noise', 'failed']
  ])('parses %j as %s', (output, expected) => {
    expect(parseOrcadSnapshotCapture(output)).toBe(expected)
  })

  it('keys the snapshot dir on both version and time, so a retry cannot overwrite one', () => {
    expect(orcadSnapshotDirName('0.2.0+bb01', 1000)).not.toBe(
      orcadSnapshotDirName('0.2.0+bb01', 2000)
    )
  })
})

describe('the host-side guard around every state mutation', () => {
  it.each([
    ['capture', () => captureOrcadStateSnapshotCommand(posix, ROOT, SNAP, BASE)],
    ['restore', () => restoreOrcadStateSnapshotCommand(posix, ROOT, SNAP, BASE)],
    ['clear', () => clearOrcadStateSnapshotMembersCommand(posix, ROOT, BASE)]
  ])('%s runs under the host lock and a host-enforced deadline', (_label, build) => {
    const command = build()
    expect(command).toContain(
      `orca_deadline="timeout -s KILL ${ORCAD_STATE_MUTATION_DEADLINE_SECONDS}"`
    )
    expect(command).toContain('orca_state_group $orca_deadline sh -c')
    expect(innerScript(command)).toContain(`lock='${BASE}/orcad-state-mutation.lock'`)
    expect(command).toContain('echo STATE_MUTATION_DEADLINE')
  })
})

describe('restoring the snapshot', () => {
  it('proves the archive extracts before clearing the live members', () => {
    const command = innerScript(restoreOrcadStateSnapshotCommand(posix, ROOT, SNAP, BASE))
    const extract = command.indexOf('tar -C "$stage" -xf "$archive"')
    expect(extract).toBeGreaterThan(-1)
    expect(extract).toBeLessThan(command.indexOf('rm -rf "$root/$m"'))
  })

  it('reports a missing archive instead of extracting nothing and claiming success', () => {
    expect(restoreOrcadStateSnapshotCommand(posix, ROOT, SNAP, BASE)).toContain('echo MISSING')
    expect(parseOrcadSnapshotRestore('MISSING')).toBe('missing')
    expect(parseOrcadSnapshotRestore('RESTORED')).toBe('restored')
    expect(parseOrcadSnapshotRestore('FAILED')).toBe('failed')
    expect(parseOrcadSnapshotRestore('RESTORED\nsh: line 1: 13 Terminated')).toBe('restored')
  })

  it.each([
    ['PRESENT', 'present'],
    ['ABSENT', 'absent'],
    ['', 'unverifiable'],
    ['bash: tar: command not found', 'unverifiable']
  ])('reads snapshot presence %j as %s, never treating silence as absence', (out, expected) => {
    expect(parseOrcadSnapshotPresence(out)).toBe(expected)
  })
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
    const command = newestStateMtimeCommand(posix, ROOT, BASE)
    for (const member of ORCAD_SNAPSHOT_MEMBERS) {
      expect(command).toContain(`'${member}'`)
    }
  })
})

describe('Windows hosts', () => {
  const BASE = 'C:/Users/u/.orca-remote'
  it.each([
    [
      'capture',
      'snapshot-capture',
      (base: string) => captureOrcadStateSnapshotCommand(windows, ROOT, SNAP, base)
    ],
    [
      'restore',
      'snapshot-restore',
      (base: string) => restoreOrcadStateSnapshotCommand(windows, ROOT, SNAP, base)
    ],
    [
      'clear',
      'snapshot-clear',
      (base: string) => clearOrcadStateSnapshotMembersCommand(windows, ROOT, base)
    ],
    [
      'presence',
      'snapshot-probe',
      (base: string) => probeOrcadStateSnapshotCommand(windows, SNAP, base)
    ],
    [
      'compare',
      'snapshot-compare',
      (base: string) => compareOrcadStateSnapshotCommand(windows, ROOT, SNAP, base)
    ],
    ['mtime', 'state-newest-mtime', (base: string) => newestStateMtimeCommand(windows, ROOT, base)]
  ])('%s runs the host script op %s with node.exe, never a POSIX command', (_label, op, build) => {
    const command = build(BASE)
    expect(command).toContain(` ${op} `)
    expect(command).toMatch(/^C:\\Users\\u\\\.orca-remote\\runtimes\\node-[0-9a-f]+\\node\.exe /u)
    expect(command).not.toMatch(/tar |find |diff |EncodedCommand|powershell/u)
  })
})
