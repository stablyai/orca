import { describe, expect, it } from 'vitest'
import {
  auditWindowsSessionCommands,
  windowsSessionCommandViolations
} from './ssh-session-command-audit'
import { powerShellCommand } from './ssh-remote-powershell'

describe('Windows session command audit', () => {
  it('decodes the gzip self-extracting form of a long script', () => {
    const long = `${'Write-Output "padding"\n'.repeat(400)}Add-Type -TypeDefinition 'x'`
    const command = powerShellCommand(long)
    expect(command).not.toContain('Add-Type')
    expect(auditWindowsSessionCommands([command]).addTypeCommands).toBe(1)
  })

  it('needs no node.exe identity on a deploy that uploaded nothing', () => {
    const audit = auditWindowsSessionCommands(['powershell.exe -NoProfile -Command "exit 0"'])
    expect(windowsSessionCommandViolations(audit, { uploaded: false })).toEqual([])
  })
})
