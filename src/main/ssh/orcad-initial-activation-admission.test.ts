import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  initialOrcadActivationAdmissionCommand,
  parseInitialOrcadActivationAdmission
} from './orcad-initial-activation-admission'
import { getRemoteHostPlatform } from './ssh-remote-platform'

function decodePowerShellCommand(command: string): string {
  const encoded = command.trim().split(/\s+/u).at(-1) ?? ''
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('initial orcad activation admission', () => {
  it('checks both supported owner records with bounded POSIX reads and no signals', () => {
    const command = initialOrcadActivationAdmissionCommand(
      getRemoteHostPlatform('linux-x64'),
      '/home/u/.orca',
      '/home/u/.orca-remote/orcad-0.2.0'
    )

    expect(command).toContain('"/home/u/.orca/orcad.lock"')
    expect(command).toContain('"/home/u/.orca/orca-runtime.json"')
    expect(command).toContain("'/home/u/.orca-remote/orcad-0.2.0/bun-runtime'")
    expect(command).toContain('65536')
    expect(command).toContain('JSON.parse')
    expect(command).toContain('O_NOFOLLOW')
    expect(command).not.toContain('sed -n')
  })

  it('checks both owner records through bounded PowerShell reads', () => {
    const script = decodePowerShellCommand(
      initialOrcadActivationAdmissionCommand(
        getRemoteHostPlatform('win32-x64'),
        'C:\\Users\\u\\.orca',
        'C:\\Users\\u\\.orca-remote\\orcad-0.2.0'
      )
    )

    expect(script).toContain('C:/Users/u/.orca/orcad.lock')
    expect(script).toContain('C:/Users/u/.orca/orca-runtime.json')
    expect(script).toContain('65536')
    expect(script).toContain('Get-Process -Id $ownerPid')
    expect(script).not.toContain('Stop-Process')
  })

  it.runIf(process.platform !== 'win32')(
    'fails closed when malformed JSON contains a dead-looking PID',
    () => {
      const testRoot = mkdtempSync(join(tmpdir(), 'orcad-owner-admission-'))
      const userDataDir = join(testRoot, 'data')
      const remoteInstallDir = join(testRoot, 'candidate')
      try {
        mkdirSync(userDataDir)
        mkdirSync(remoteInstallDir)
        symlinkSync(process.execPath, join(remoteInstallDir, 'bun-runtime'))
        writeFileSync(join(userDataDir, 'orcad.lock'), '{"pid":2147483647} trailing-data')

        const output = execFileSync(
          '/bin/sh',
          [
            '-c',
            initialOrcadActivationAdmissionCommand(
              getRemoteHostPlatform('linux-x64'),
              userDataDir,
              remoteInstallDir
            )
          ],
          { encoding: 'utf8' }
        )

        expect(output.trim()).toBe('UNVERIFIABLE orcad.lock')
      } finally {
        rmSync(testRoot, { recursive: true, force: true })
      }
    }
  )

  it('admits only a host-clear result', () => {
    expect(parseInitialOrcadActivationAdmission('CLEAR')).toEqual({ decision: 'proceed' })
    expect(parseInitialOrcadActivationAdmission('LIVE orcad.lock 42')).toMatchObject({
      decision: 'defer',
      code: 'orcad_initial_runtime_live'
    })
    expect(parseInitialOrcadActivationAdmission('UNVERIFIABLE orca-runtime.json')).toMatchObject({
      decision: 'defer',
      code: 'orcad_initial_runtime_unverifiable'
    })
    expect(parseInitialOrcadActivationAdmission('')).toMatchObject({
      decision: 'defer',
      code: 'orcad_initial_runtime_unverifiable'
    })
  })
})
