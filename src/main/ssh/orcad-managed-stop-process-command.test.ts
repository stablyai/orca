import { describe, expect, it } from 'vitest'
import type { OrcadManagedStopRequest } from '../../shared/orcad-managed-stop-request'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import {
  managedStopOrcadCommand,
  parseManagedStopOrcadCompletion
} from './orcad-managed-stop-process-command'

const request: OrcadManagedStopRequest = {
  schemaVersion: 1,
  version: '1.0.0',
  authority: {
    runtimeId: 'runtime',
    profileId: 'profile',
    profileRoot: '/profile',
    transactionId: '00000000-0000-4000-8000-000000000001'
  },
  instance: { pid: 123, startedAtMs: null, nonce: 'instance', lockPath: '/data/orcad.lock' }
}
const receipt = () => ({
  ...request,
  kind: 'orcad_managed_stop_completion',
  verdict: 'exited',
  receiptPersisted: true
})

describe('bound process completion transport', () => {
  it.each([undefined, false])(
    'refuses exit without confirmed durable receipt publication (%s)',
    (receiptPersisted) => {
      expect(
        parseManagedStopOrcadCompletion(JSON.stringify({ ...receipt(), receiptPersisted }), request)
      ).toBe('unverifiable')
    }
  )
  it.each(['live', 'unverifiable', 'exited'] as const)('accepts an exact %s receipt', (verdict) => {
    expect(
      parseManagedStopOrcadCompletion(JSON.stringify({ ...receipt(), verdict }), request)
    ).toBe(verdict)
  })
  it.each([
    '',
    'STOPPED',
    'ALREADY_EXITED',
    '{}',
    '{',
    JSON.stringify({ ...receipt(), instance: undefined })
  ])('refuses absent or legacy proof %#', (output) => {
    expect(parseManagedStopOrcadCompletion(output, request)).toBe('unverifiable')
  })
  it('refuses another instance or authority', () => {
    expect(
      parseManagedStopOrcadCompletion(
        JSON.stringify({ ...receipt(), instance: { ...request.instance, nonce: 'other' } }),
        request
      )
    ).toBe('unverifiable')
    expect(
      parseManagedStopOrcadCompletion(
        JSON.stringify({ ...receipt(), authority: { ...request.authority, profileId: 'other' } }),
        request
      )
    ).toBe('unverifiable')
  })
  it('invokes only the bundled runtime without slot PID commands or Node fallback', () => {
    const command = managedStopOrcadCommand(
      getRemoteHostPlatform('linux-x64'),
      '/slot space',
      request,
      '/user home'
    )
    expect(command).toContain("'/slot space/bun-runtime'")
    expect(command).toContain("'--complete-managed-stop'")
    expect(command).toContain("'/user home'")
    expect(command).not.toMatch(/\.orcad-pid|kill|node/)
  })
  it('uses the Windows runtime filename and encoded PowerShell invocation', () => {
    const command = managedStopOrcadCommand(
      getRemoteHostPlatform('win32-x64'),
      'C:\\slot space',
      request,
      'C:\\user home'
    )
    const encoded = command.trim().split(' ').at(-1)!
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(script).toContain('bun-runtime.exe')
    expect(script).toContain('--complete-managed-stop')
    expect(script).not.toContain('Get-Process')
  })
})
