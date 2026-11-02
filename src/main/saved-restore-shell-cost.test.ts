import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  annotateSavedRestore,
  FISH_SAVED_RESTORE_INSTALL,
  POSIX_SAVED_RESTORE_CAPTURE,
  POSIX_SAVED_RESTORE_INSTALL,
  renderSavedRestoreStartupCommand
} from '../shared/saved-restore-dispatch'
import { getFishSavedRestoreScript } from '../shared/saved-restore-scripts'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from './powershell-osc133-bootstrap'
import { getBashShellReadyRcfileContent } from './providers/local-pty-shell-ready-bash-rcfile'
import { getDaemonBashShellReadyRcfileContent } from './daemon/daemon-bash-shell-ready-rcfile'
import { resolveWindowsShellLaunchArgs } from './providers/windows-shell-args'

const ENTRY = '0123456789abcdef'
const TOKEN = '0123456789abcdef0123456789abcdef'
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('what every pane start carries for saved restores', () => {
  it('loads no restore code and runs no command unless the launch was armed', () => {
    for (const always of [
      getBashShellReadyRcfileContent(),
      getDaemonBashShellReadyRcfileContent(),
      getPowerShellOsc133Bootstrap()
    ]) {
      expect(always).not.toMatch(/__orca_sr_run|__OrcaSRRun|__orca_sr_check|__OrcaSRFresh/)
    }
    // The capture and installer are builtins only: no substitution, pipeline or external command.
    for (const snippet of [POSIX_SAVED_RESTORE_CAPTURE, POSIX_SAVED_RESTORE_INSTALL]) {
      expect(snippet).not.toMatch(/\$\(|`|\|/)
    }
    const dir = mkdtempSync(join(tmpdir(), 'orca-restore-cost-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'restore.sh'), 'echo LOADED\n')
    const start = (env: string[]) =>
      spawnSync(
        '/usr/bin/env',
        [
          '-i',
          ...env,
          '/bin/bash',
          '--norc',
          '-c',
          `${POSIX_SAVED_RESTORE_CAPTURE}\n${POSIX_SAVED_RESTORE_INSTALL}`
        ],
        { encoding: 'utf8' }
      ).stdout.trim()
    expect(start([`ORCA_SAVED_RESTORE_SCRIPT=${join(dir, 'restore')}`])).toBe('')
    expect(
      start([
        `ORCA_SAVED_RESTORE_SCRIPT=${join(dir, 'restore')}`,
        `ORCA_SAVED_RESTORE_ENTRY=${ENTRY}`
      ])
    ).toBe('LOADED')
  })

  it('keeps the PowerShell bootstrap near its earlier size, with room for a long cwd and restore line', () => {
    const encoded = encodePowerShellCommand(getPowerShellOsc133Bootstrap()).length
    // 23,360 before this feature; the one-line installer is the only addition.
    expect(encoded).toBeLessThanOrEqual(24_300)
    const cwd = `C:\\Users\\${'a'.repeat(240)}`
    const restore = annotateSavedRestore(
      `& 'claude' '--resume' '21f5e73a-4a3a-42ac-bd73-bc8d88256d65' '--permission-mode' 'acceptEdits'`,
      ENTRY,
      TOKEN
    )
    for (const shell of ['powershell.exe', 'pwsh.exe']) {
      const launch = resolveWindowsShellLaunchArgs(shell, cwd, 'C:\\', undefined, restore)
      expect(launch.startupCommandDeliveredInShellArgs).toBe(true)
      expect(launch.shellArgs.at(-1)!.length).toBeLessThan(28_400)
    }
  })
})

// Shipped distributions still carry fish 3.0 (Debian 10, Ubuntu 18.04). No fish 3.0 binary is on
// this machine, so the restore text is held to the 3.0 grammar here and parsed by the local fish.
const FISH_31_SYNTAX = [
  /(^|;|\b(?:and|or|if|not|begin|else|then))\s*[A-Za-z_][A-Za-z0-9_]*=\S/m,
  /\$\(/,
  /\bstring (?:collect|pad|shorten)\b/,
  /\bfish_add_path\b/,
  /\bset (?:-f|--function)\b/
]

describe('fish restore text', () => {
  const texts = [
    FISH_SAVED_RESTORE_INSTALL,
    getFishSavedRestoreScript(),
    renderSavedRestoreStartupCommand(
      annotateSavedRestore(`claude '--resume' 'X'`, ENTRY, TOKEN),
      '/usr/bin/fish'
    )
  ]
  it('uses only fish 3.0 syntax', () => {
    for (const text of texts) {
      for (const pattern of FISH_31_SYNTAX) {
        expect(text).not.toMatch(pattern)
      }
    }
  })

  it.skipIf(!existsSync('/opt/homebrew/bin/fish'))('parses in the local fish', () => {
    for (const text of texts) {
      const result = spawnSync('/opt/homebrew/bin/fish', ['--no-execute', '-c', text], {
        encoding: 'utf8'
      })
      expect(result.stderr).toBe('')
    }
  })
})
