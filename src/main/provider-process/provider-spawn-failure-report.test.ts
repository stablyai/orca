import { describe, expect, it } from 'vitest'
import {
  PROVIDER_SPAWN_FAILURE_MARKER,
  providerStderrForDisplay,
  supervisedProviderSpawnFailure
} from './provider-spawn-failure-report'

describe('provider spawn failure report', () => {
  const report = (thrown: boolean, code: string, message: string): string =>
    `${PROVIDER_SPAWN_FAILURE_MARKER}${JSON.stringify({ thrown, code, message })}\n`

  it.each([
    ['an emitted ENOENT', report(false, 'ENOENT', 'spawn /opt/my tools/claude ENOENT'), false],
    ['a thrown ENOTDIR', report(true, 'ENOTDIR', 'spawn ENOTDIR'), true],
    [
      'a report after a runtime warning',
      `Warning: Ignoring extra certs from \`/missing.pem\`, load failed\n${report(false, 'EACCES', 'spawn /opt/claude EACCES')}`,
      false
    ]
  ])('reads %s from the supervisor last stderr line', (_, stderr, thrown) => {
    const failure = supervisedProviderSpawnFailure(127, stderr)

    expect(failure?.thrown).toBe(thrown)
    expect(failure?.error.code).toMatch(/^E[A-Z]+$/)
    expect(failure?.error.message).toMatch(/^spawn /)
  })

  it.each([
    ['another exit code', 1, report(false, 'ENOENT', 'spawn claude ENOENT')],
    ['a provider line after the report', 127, `${report(true, 'ENOEXEC', 'spawn ENOEXEC')}more\n`],
    ['an unmarked spawn line', 127, 'spawn claude ENOENT\n'],
    ['a malformed report', 127, `${PROVIDER_SPAWN_FAILURE_MARKER}{"thrown":true}\n`]
  ])('reads no spawn failure from %s', (_, code, stderr) => {
    expect(supervisedProviderSpawnFailure(code, stderr)).toBeNull()
  })

  it('shows a report as the spawn error a direct spawn gives, and other stderr unchanged', () => {
    expect(
      providerStderrForDisplay(
        `Warning: a runtime notice\n${report(false, 'ENOENT', 'spawn /opt/claude ENOENT')}`
      )
    ).toBe('Warning: a runtime notice\nspawn /opt/claude ENOENT\n')
    expect(providerStderrForDisplay('Error: auth failed\n')).toBe('Error: auth failed\n')
  })
})
