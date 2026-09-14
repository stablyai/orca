import { describe, expect, it } from 'vitest'
import {
  FALLBACK_WINDOWS_EXECUTION_POLICY,
  PREFERRED_WINDOWS_EXECUTION_POLICY,
  isExecutionPolicyBlocked,
  windowsPowerShellRuntimeArgs
} from './windows-powershell-execution-policy'

/**
 * Captured from powershell.exe on Windows, verbatim including the hard wrapping.
 *
 * The discriminator has to be pinned in both directions: a policy block must
 * escalate once, and a plain access denial must not, because escalation is
 * sticky for the session and lands on `-ExecutionPolicy Bypass`.
 */
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
    // UnauthorizedAccessException merely starts with the policy error id. Without
    // the word boundary this matched, and one locked file downgraded the whole
    // session to Bypass with no path back.
    expect(isExecutionPolicyBlocked(GENUINE_ACCESS_DENIED)).toBe(false)
  })

  it('keeps recognising a block when the record labels are localized', () => {
    // The labels are translated on a non-English host; the ids and the help
    // topic are not, so the match must not depend on the labels.
    const localized = POLICY_BLOCKED_RESTRICTED.replace('CategoryInfo', 'Categoria')
      .replace('FullyQualifiedErrorId', 'IdErroreCompleto')
      .replace(
        'cannot be loaded because running scripts is disabled on this system',
        'non puo essere caricato'
      )
    expect(isExecutionPolicyBlocked(localized)).toBe(true)
  })

  it('ignores the failures the helper reports every day', () => {
    expect(isExecutionPolicyBlocked('code 1: The term is not recognized')).toBe(false)
    expect(isExecutionPolicyBlocked('Add-Type : Cannot access the temporary directory')).toBe(false)
    expect(isExecutionPolicyBlocked('')).toBe(false)
  })
})

describe('windowsPowerShellRuntimeArgs', () => {
  it('never emits Bypass unless the caller escalated to it', () => {
    const preferred = windowsPowerShellRuntimeArgs(
      'C:\\orca\\runtime.ps1',
      PREFERRED_WINDOWS_EXECUTION_POLICY,
      ['-Serve']
    )
    expect(preferred).not.toContain(FALLBACK_WINDOWS_EXECUTION_POLICY)
    expect(preferred).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'RemoteSigned',
      '-File',
      'C:\\orca\\runtime.ps1',
      '-Serve'
    ])
  })
})
