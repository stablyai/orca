import { describe, expect, it } from 'vitest'
import {
  auditWindowsSessionCommands,
  windowsSessionCommandViolations
} from './ssh-session-command-audit'
import { powerShellCommand } from './ssh-remote-powershell'
import { reserveWindowsRelayUploadStageCommand } from './ssh-relay-upload-stage-windows-commands'

const POOL = 'C:/Users/orca/.orca-remote/.upload-stages'
const OWNER = '.sftp-namespace-0123456789abcdef0123456789abcdef'
const NODE = 'C:/Users/orca/.orca-remote/runtimes/node-abc/node.exe'

describe('Windows session command audit', () => {
  it('sees Add-Type through -EncodedCommand in the legacy stage fence', () => {
    const audit = auditWindowsSessionCommands([reserveWindowsRelayUploadStageCommand(POOL, OWNER)])
    expect(audit).toEqual({ commandCount: 1, addTypeCommands: 1, nodeStageIdentityCommands: 0 })
    expect(windowsSessionCommandViolations(audit, { uploaded: true })).toEqual([
      '1 of 1 commands ran Add-Type',
      'no upload stage read file identities through the pinned node.exe'
    ])
  })

  it('passes a stage fence that reads identities through the verified node.exe', () => {
    const audit = auditWindowsSessionCommands([
      'uname -s',
      reserveWindowsRelayUploadStageCommand(POOL, OWNER, { node: NODE })
    ])
    expect(audit).toEqual({ commandCount: 2, addTypeCommands: 0, nodeStageIdentityCommands: 1 })
    expect(windowsSessionCommandViolations(audit, { uploaded: true })).toEqual([])
  })

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
