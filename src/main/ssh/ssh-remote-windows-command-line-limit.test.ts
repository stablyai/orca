import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { CMD_EXE_COMMAND_LINE_MAX_CHARS } from '../providers/windows-shell-args'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { tryStealInstallLockCommand } from './ssh-relay-install-lock-commands'
import { decodeRemotePowerShellScript, powerShellCommand } from './ssh-remote-powershell'
import {
  makeWindowsPublishStagedFileCommand,
  makeWindowsWriteFileCommand
} from './system-ssh-windows-file-write'
import {
  cleanupOwnedRelayUploadStageCommand,
  promoteOwnedRelayUploadStageCommand,
  recoverOneStaleRelayUploadStageCommand,
  reserveRelayUploadStageCommand,
  type RelayUploadStageSlot
} from './ssh-relay-upload-stage-commands'

const windows = getRemoteHostPlatform('win32-x64')
const owner = '.sftp-namespace-123e4567e89b12d3a456426614174000'
const pool = 'C:\\Users\\orca\\.orca-remote\\.upload-stages'
const stage: RelayUploadStageSlot = {
  poolDir: pool,
  slotName: 'slot-0',
  slotDir: `${pool}\\slot-0`,
  claimDir: `${pool}\\claim-0`,
  deleteDir: `${pool}\\delete-0`
}

// Why: sshd runs an exec request through its DefaultShell, which is cmd.exe on a
// stock Windows OpenSSH install, and cmd.exe refuses a longer line with exit 1
// and a localized "The command line is too long" — the whole connect dies there.
describe('Windows remote command line limit', () => {
  it.each([
    ['recover stale upload stage', recoverOneStaleRelayUploadStageCommand(windows, pool)],
    ['reserve upload stage', reserveRelayUploadStageCommand(windows, pool, owner)],
    [
      'promote upload stage',
      promoteOwnedRelayUploadStageCommand(windows, stage, owner, 'C:\\Users\\orca\\.orca-remote')
    ],
    ['cleanup upload stage', cleanupOwnedRelayUploadStageCommand(windows, stage, owner)],
    [
      'steal stale install lock',
      tryStealInstallLockCommand(windows, 'C:\\Users\\orca\\.orca-remote\\relay', 1_200)
    ],
    // F11 flagged these two as uncovered. They carry one path literal each, so they are the file
    // commands whose length a caller can actually move.
    ['write file', makeWindowsWriteFileCommand('C:\\Users\\orca\\.orca-remote\\relay.js')],
    [
      'publish staged file',
      makeWindowsPublishStagedFileCommand(
        'C:\\Users\\orca\\.orca-remote\\relay.js.orca-partial-0123456789ab',
        'C:\\Users\\orca\\.orca-remote\\relay.js',
        'create'
      )
    ]
  ])('keeps the %s command inside what sshd\u2019s cmd.exe accepts', (_name, command) => {
    expect(command.length).toBeLessThanOrEqual(CMD_EXE_COMMAND_LINE_MAX_CHARS)
  })

  it('leaves a command that already fits byte-identical', () => {
    const script = "Write-Output ([Environment]::GetFolderPath('UserProfile'))"
    expect(decodeRemotePowerShellScript(powerShellCommand(script))).toBe(script)
  })

  it('carries an oversized script through gzip without altering it', () => {
    const script = Array.from(
      { length: 200 },
      (_unused, index) => `Write-Output ${index}; $slot = 'C:\\Users\\orca\\stage-${index}'`
    ).join('\n')
    const command = powerShellCommand(script)
    expect(command.length).toBeLessThanOrEqual(CMD_EXE_COMMAND_LINE_MAX_CHARS)
    expect(decodeRemotePowerShellScript(command)).toBe(script)
    const bootstrap = Buffer.from(
      command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)$/u)?.[1] ?? '',
      'base64'
    ).toString('utf16le')
    const payload = bootstrap.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/u)?.[1] ?? ''
    expect(gunzipSync(Buffer.from(payload, 'base64')).toString('utf-8')).toBe(script)
    expect(bootstrap).toContain('Invoke-Expression $OrcaScriptText')
  })

  it('refuses a script no encoding can fit instead of letting cmd.exe reject it', () => {
    let seed = 12345
    const incompressible = Array.from({ length: 60_000 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return String.fromCharCode(97 + (seed % 26))
    }).join('')
    expect(() => powerShellCommand(`Write-Output '${incompressible}'`)).toThrow(
      /Orca budgets 8000 for a line sshd hands to cmd\.exe/u
    )
  })
})

/**
 * F11 asked whether a pathological path could reach the budget, and what happens if it does.
 * Measured: the inline encoding crosses 8000 at roughly 2500 high-entropy path characters — an
 * order of magnitude past what Windows itself accepts — and the failure is a throw before any ssh
 * is spawned, never a hang.
 */
describe('Windows file command budget headroom', () => {
  it('absorbs a path far longer than Windows will accept', () => {
    const deep = `C:\\Users\\orca\\${'segment\\'.repeat(30)}relay.js`

    expect(deep.length).toBeGreaterThan(260)
    expect(makeWindowsWriteFileCommand(deep).length).toBeLessThanOrEqual(
      CMD_EXE_COMMAND_LINE_MAX_CHARS
    )
  })

  it('throws rather than spawning a line cmd.exe would refuse', () => {
    // Random segments so gzip cannot rescue it, which is the only way to reach the ceiling at all.
    const incompressible = Array.from(
      { length: 400 },
      (_unused, index) => `${index}-${Math.random().toString(36).slice(2)}`
    ).join('\\')

    expect(() => makeWindowsWriteFileCommand(`C:\\${incompressible}\\f.bin`)).toThrow(
      /Orca budgets 8000/
    )
  })
})
