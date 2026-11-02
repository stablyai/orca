import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FISH_SAVED_RESTORE_CAPTURE,
  FISH_SAVED_RESTORE_INSTALL,
  POSIX_SAVED_RESTORE_CAPTURE,
  POSIX_SAVED_RESTORE_INSTALL,
  POWERSHELL_SAVED_RESTORE_INSTALL
} from '../shared/saved-restore-dispatch'
import { getFishSavedRestoreScript } from '../shared/saved-restore-scripts'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from './powershell-osc133-bootstrap'
import { getBashShellReadyRcfileContent } from './providers/local-pty-shell-ready-bash-rcfile'
import { getDaemonBashShellReadyRcfileContent } from './daemon/daemon-bash-shell-ready-rcfile'
import { resolveWindowsShellLaunchArgs } from './providers/windows-shell-args'
import { getFishAgentInit } from './saved-restore-shell-launch'
import { getFishShellReadyInitCommand } from './shell-templates'
import { savedRestoreWindowsStartup } from '../shared/saved-restore-dispatch'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('what every pane start carries for saved restores', () => {
  it('loads no restore code and runs nothing unless the launch owns a saved restore', () => {
    for (const always of [
      getBashShellReadyRcfileContent(),
      getDaemonBashShellReadyRcfileContent(),
      getPowerShellOsc133Bootstrap(),
      getFishAgentInit(false)
    ]) {
      // The restore definitions and bodies live only in the on-demand script.
      expect(always).not.toMatch(/__orca_sr_check\(\)|__orca_sr_body_|__OrcaSRFresh|__OrcaSRBody_/)
    }
    expect(getFishAgentInit(false)).not.toContain('__orca_sr')
    // Builtins only on an ordinary start: no substitution or backtick in the capture/installer.
    for (const snippet of [POSIX_SAVED_RESTORE_CAPTURE, POSIX_SAVED_RESTORE_INSTALL]) {
      expect(snippet).not.toMatch(/\$\(|`/)
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
          `${POSIX_SAVED_RESTORE_CAPTURE}\n${POSIX_SAVED_RESTORE_INSTALL}\ndeclare -F __orca_sr_prompt || echo NONE`
        ],
        { encoding: 'utf8' }
      ).stdout.trim()
    expect(start([`ORCA_SAVED_RESTORE_SCRIPT=${join(dir, 'restore')}`])).toBe('NONE')
  })

  it('keeps the PowerShell bootstrap constant, with the startup slot fitting a long cwd and quotes', () => {
    const bootstrap = encodePowerShellCommand(getPowerShellOsc133Bootstrap()).length
    // 23,360 before this feature; the constant capture line is the only addition.
    expect(bootstrap).toBeLessThanOrEqual(24_000)
    expect(POWERSHELL_SAVED_RESTORE_INSTALL).not.toMatch(/\$\(/)
    const cwd = `C:\\Users\\${'a'.repeat(120)}\\O'Brien project\\${'b'.repeat(110)}`
    const original = `& 'claude' '--resume' '21f5e73a-4a3a-42ac-bd73-bc8d88256d65' '--append-system-prompt' 'it''s "quoted" & long'`
    const env = { ORCA_SAVED_RESTORE_ACTION: 'C:\\x\\action' }
    for (const shell of ['powershell.exe', 'pwsh.exe']) {
      const slot = savedRestoreWindowsStartup(shell, original, env)!
      expect(slot).toContain(original)
      const launch = resolveWindowsShellLaunchArgs(shell, cwd, 'C:\\', undefined, slot)
      expect(launch.startupCommandDeliveredInShellArgs).toBe(true)
      expect(launch.shellArgs.at(-1)!.length).toBeLessThan(28_400)
    }
    // An unarmed start and the setup runner keep their plain command.
    expect(savedRestoreWindowsStartup('pwsh.exe', original, {})).toBe(original)
  })
})

// Shipped distributions still carry fish 3.0 (Debian 10, Ubuntu 18.04). No fish 3.0 binary is on
// this machine, so the restore text is held to the 3.0 grammar here and parsed by the local fish;
// running it on fish 3.0 is owed in QA.
const FISH_31_SYNTAX = [
  /(^|;|\b(?:and|or|if|not|begin|else|then))\s*[A-Za-z_][A-Za-z0-9_]*=\S/m,
  /\$\(/,
  /\bstring (?:collect|pad|shorten)\b/,
  /\bfish_add_path\b/,
  /\bset (?:-f|--function)\b/,
  /\beval set argv\b/,
  /\bhistory append\b/
]

describe('fish restore text', () => {
  const texts = [
    `${getFishShellReadyInitCommand('\\033]777;orca-shell-ready\\007', true, false, true)}\n${getFishAgentInit(true)}`,
    FISH_SAVED_RESTORE_CAPTURE,
    FISH_SAVED_RESTORE_INSTALL,
    getFishSavedRestoreScript()
  ]
  it('uses only fish 3.0 syntax, and sets fresh arguments from a literal list', () => {
    for (const text of texts) {
      for (const pattern of FISH_31_SYNTAX) {
        expect(text).not.toMatch(pattern)
      }
    }
    expect(getFishSavedRestoreScript()).toContain('set argv $__orca_sr_fresh')
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
