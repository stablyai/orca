import { describe, expect, it } from 'vitest'
import { isExecutionPolicyBlocked } from './windows-powershell-execution-policy'

/** Captured PowerShell errors, preserving console hard wrapping. */
const POLICY_BLOCKED_RESTRICTED = [
  'File C:\\Temp\\runtime.ps1 cannot be loaded because running scripts is disabled on this system. For more ',
  'information, see about_Execution_Policies at https:/go.microsoft.com/fwlink/?LinkID=135170.',
  '    + CategoryInfo          : SecurityError: (:) [], ParentContainsErrorRecordException',
  '    + FullyQualifiedErrorId : UnauthorizedAccess'
].join('\r\n')

const POLICY_BLOCKED_REMOTE_SIGNED = [
  'File C:\\Temp\\runtime.ps1 cannot be loaded. The file ',
  'C:\\Temp\\runtime.ps1 is not digitally signed. You cannot run this script on the current system. For more ',
  'information about running scripts and setting execution policy, see about_Execution_Policies at https:/go.microsoft.com/fwlink/?LinkID=135170.',
  '    + CategoryInfo          : SecurityError: (:) [], ParentContainsErrorRecordException',
  '    + FullyQualifiedErrorId : UnauthorizedAccess'
].join('\r\n')

/** No execution policy involved: .NET refusing a file the process may not read. */
const GENUINE_ACCESS_DENIED = [
  'Exception calling "ReadAllText" with "1" argument(s): "Access to the path \'C:\\Windows\\System32\\config\\SAM\' is denied."',
  'At C:\\Temp\\runtime.ps1:1 char:1',
  '+ [System.IO.File]::ReadAllText("C:\\Windows\\System32\\config\\SAM")',
  '+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '    + CategoryInfo          : NotSpecified: (:) [], MethodInvocationException',
  '    + FullyQualifiedErrorId : UnauthorizedAccessException'
].join('\r\n')

describe('isExecutionPolicyBlocked', () => {
  it('recognises a policy block under either policy', () => {
    expect(isExecutionPolicyBlocked(POLICY_BLOCKED_RESTRICTED)).toBe(true)
    expect(isExecutionPolicyBlocked(POLICY_BLOCKED_REMOTE_SIGNED)).toBe(true)
  })

  it('does not read a plain access denial as a policy block', () => {
    // The word boundary distinguishes a policy ID from UnauthorizedAccessException.
    expect(isExecutionPolicyBlocked(GENUINE_ACCESS_DENIED)).toBe(false)
  })

  it('keeps recognising a block when the record labels are localized', () => {
    // Error IDs and the help topic stay stable when labels are localized.
    const localized = POLICY_BLOCKED_RESTRICTED.replace('CategoryInfo', 'Categoria')
      .replace('FullyQualifiedErrorId', 'IdErroreCompleto')
      .replace(
        'cannot be loaded because running scripts is disabled on this system',
        'non puo essere caricato'
      )
    expect(isExecutionPolicyBlocked(localized)).toBe(true)
  })
})
