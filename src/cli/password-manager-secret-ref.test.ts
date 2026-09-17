import { describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../shared/child-process/process-spec'
import { buildSecretRefCommand, resolveSecretRef } from './password-manager-secret-ref'

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

describe('buildSecretRefCommand', () => {
  it('reads a 1Password ref with the ref itself, never the secret, in argv', () => {
    expect(buildSecretRefCommand('op://Private/Acme staging/password', {})).toEqual({
      program: 'op',
      args: ['read', '--no-newline', 'op://Private/Acme staging/password']
    })
  })

  it('defaults a Bitwarden ref to the password field', () => {
    expect(buildSecretRefCommand('bw://acme-staging', {})).toEqual({
      program: 'bw',
      args: ['get', 'password', 'acme-staging']
    })
  })

  it('reads an explicit Bitwarden field', () => {
    expect(buildSecretRefCommand('bw://acme-staging/totp', {})).toEqual({
      program: 'bw',
      args: ['get', 'totp', 'acme-staging']
    })
  })

  it('uses the environment override when the vendor CLI is off PATH', () => {
    expect(
      buildSecretRefCommand('op://Private/Acme/password', { ORCA_OP_CLI: '/opt/1password/op' })
        .program
    ).toBe('/opt/1password/op')
  })

  it.each([
    ['op://Private/Acme', 'expected op://<vault>/<item>/<field>'],
    ['op://Private//password', 'empty path segment'],
    ['op://Private/-item/password', 'may not start with "-"'],
    ['bw://acme/secretNotes', 'field must be one of'],
    ['bw://acme/password/extra', 'expected bw://<item>[/<field>]'],
    ['https://example.com', 'expected op:// or bw://']
  ])('rejects %s', (ref, message) => {
    expect(() => buildSecretRefCommand(ref, {})).toThrow(message)
  })
})

describe('resolveSecretRef', () => {
  it('returns the secret without its trailing newline', async () => {
    const run = vi.fn(async () => processResult({ stdout: 'hunter2\n' }))
    await expect(resolveSecretRef('bw://acme', { env: {}, run })).resolves.toBe('hunter2')
  })

  it('passes the lookup timeout so an unattended fill cannot hang forever', async () => {
    const specs: ProcessSpec[] = []
    const run = vi.fn(async (spec: ProcessSpec) => {
      specs.push(spec)
      return processResult({ stdout: 'hunter2' })
    })
    await resolveSecretRef('bw://acme', { env: {}, run })
    expect(specs[0]?.timeoutMs).toBeGreaterThan(0)
  })

  it('reports stderr but never stdout when the vendor CLI fails', async () => {
    const run = vi.fn(async () =>
      processResult({ code: 1, stdout: 'hunter2', stderr: 'error: not signed in\n' })
    )
    const error = await resolveSecretRef('op://Private/Acme/password', { env: {}, run }).catch(
      (thrown: unknown) => thrown
    )
    expect(String(error)).toContain('not signed in')
    expect(String(error)).not.toContain('hunter2')
  })

  it('names the timeout instead of reporting an unknown exit', async () => {
    const run = vi.fn(async () => processResult({ code: null, timedOut: true }))
    await expect(resolveSecretRef('bw://acme', { env: {}, run })).rejects.toThrow(/timed out/)
  })

  it('rejects a timed-out lookup even when the runner reports a zero exit', async () => {
    const run = vi.fn(async () => processResult({ code: 0, stdout: 'partial', timedOut: true }))
    await expect(resolveSecretRef('bw://acme', { env: {}, run })).rejects.toThrow(/timed out/)
  })

  it('fails when the vendor CLI returns nothing', async () => {
    const run = vi.fn(async () => processResult({ stdout: '\n' }))
    await expect(resolveSecretRef('bw://acme', { env: {}, run })).rejects.toThrow(
      /returned an empty value/
    )
  })

  it('fails with the ref when the vendor CLI is missing', async () => {
    const run = vi.fn(async () => {
      throw new Error('spawn op ENOENT')
    })
    await expect(resolveSecretRef('op://Private/Acme/password', { env: {}, run })).rejects.toThrow(
      /could not start op/
    )
  })
})
