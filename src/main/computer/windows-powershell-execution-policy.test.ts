import { describe, expect, it } from 'vitest'
import {
  buildWindowsPowerShellFileArgs,
  isPowerShellExecutionPolicyBlocked
} from './windows-powershell-execution-policy'

describe('buildWindowsPowerShellFileArgs', () => {
  it('builds RemoteSigned -File argv without Bypass or EncodedCommand', () => {
    expect(
      buildWindowsPowerShellFileArgs(
        'C:\\Orca\\runtime.ps1',
        'C:\\tmp\\operation.json',
        'RemoteSigned'
      )
    ).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'RemoteSigned',
      '-File',
      'C:\\Orca\\runtime.ps1',
      'C:\\tmp\\operation.json'
    ])
  })

  it('builds the Bypass retry argv with the same -File operands', () => {
    expect(
      buildWindowsPowerShellFileArgs('C:\\Orca\\runtime.ps1', 'C:\\tmp\\operation.json', 'Bypass')
    ).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\Orca\\runtime.ps1',
      'C:\\tmp\\operation.json'
    ])
  })
})

describe('isPowerShellExecutionPolicyBlocked', () => {
  it('matches Restricted-host script-disabled stderr', () => {
    expect(
      isPowerShellExecutionPolicyBlocked(
        'File C:\\Orca\\runtime.ps1 cannot be loaded because running scripts is disabled on this system. For more information, see about_Execution_Policies at https://go.microsoft.com/fwlink/?LinkID=135170.'
      )
    ).toBe(true)
  })

  it('matches unsigned-script execution policy stderr', () => {
    expect(
      isPowerShellExecutionPolicyBlocked(
        'is not digitally signed. You cannot run this script on the current system. For more information about running scripts and setting execution policy, see about_Execution_Policies.'
      )
    ).toBe(true)
  })

  it('does not treat a phrase-only execution policy mention as a policy block', () => {
    expect(isPowerShellExecutionPolicyBlocked('execution policy configuration is invalid')).toBe(
      false
    )
  })

  it('does not treat unrelated bridge errors as a policy block', () => {
    expect(isPowerShellExecutionPolicyBlocked("app 'Finder' has no on-screen window")).toBe(false)
    expect(isPowerShellExecutionPolicyBlocked('screenshot failed: payload cap')).toBe(false)
  })
})
