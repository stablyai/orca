import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_EXPECTED_SIGNER,
  classifySignature,
  getPowerShellSignatureJson,
  normalizeSignerSubject,
  normalizeThumbprint,
  parseExpectedSigners,
  parseExpectedThumbprints,
  parseSignatureJson,
  validateExecutablePath,
  verifyWindowsInnerSignature
} from './verify-windows-inner-signature.mjs'

const validSignature = {
  status: 'Valid',
  statusMessage: 'Signature verified.',
  signerSubject: DEFAULT_EXPECTED_SIGNER,
  signerIssuer: 'CN=SignPath Foundation Root',
  signerThumbprint: 'aa bb cc dd',
  notBefore: '2026-01-01T00:00:00.0000000Z',
  notAfter: '2027-01-01T00:00:00.0000000Z'
}

function withTempFile(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-inner-signature-'))
  const filePath = join(dir, 'Orca.exe')
  writeFileSync(filePath, 'placeholder executable')

  try {
    return callback(filePath, dir)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

describe('verify-windows-inner-signature', () => {
  const originalExpectedSigners = process.env.ORCA_WINDOWS_EXPECTED_SIGNERS
  const originalExpectedThumbprints = process.env.ORCA_WINDOWS_EXPECTED_THUMBPRINTS

  beforeEach(() => {
    delete process.env.ORCA_WINDOWS_EXPECTED_SIGNERS
    delete process.env.ORCA_WINDOWS_EXPECTED_THUMBPRINTS
  })

  afterEach(() => {
    if (originalExpectedSigners === undefined) {
      delete process.env.ORCA_WINDOWS_EXPECTED_SIGNERS
    } else {
      process.env.ORCA_WINDOWS_EXPECTED_SIGNERS = originalExpectedSigners
    }

    if (originalExpectedThumbprints === undefined) {
      delete process.env.ORCA_WINDOWS_EXPECTED_THUMBPRINTS
    } else {
      process.env.ORCA_WINDOWS_EXPECTED_THUMBPRINTS = originalExpectedThumbprints
    }
  })

  it('normalizes signer subjects without widening exact matching', () => {
    expect(
      normalizeSignerSubject(
        ' CN = SignPath Foundation , O=SignPath Foundation,L=Lewes,S=Delaware,C=US '
      )
    ).toBe(DEFAULT_EXPECTED_SIGNER)
    expect(
      normalizeSignerSubject(
        'CN=Different Signer, O=SignPath Foundation, L=Lewes, S=Delaware, C=US'
      )
    ).not.toBe(DEFAULT_EXPECTED_SIGNER)
  })

  it('defaults the expected signer allowlist to SignPath Foundation', () => {
    expect(parseExpectedSigners('')).toEqual([DEFAULT_EXPECTED_SIGNER])
    expect(parseExpectedSigners('   ')).toEqual([DEFAULT_EXPECTED_SIGNER])
  })

  it('parses semicolon and newline separated signer allowlists', () => {
    expect(parseExpectedSigners(`${DEFAULT_EXPECTED_SIGNER};\nCN=Backup, O=Backup`)).toEqual([
      DEFAULT_EXPECTED_SIGNER,
      'CN=Backup, O=Backup'
    ])
  })

  it('normalizes optional thumbprint allowlists', () => {
    expect(normalizeThumbprint('aa bb:cc')).toBe('AABBCC')
    expect(parseExpectedThumbprints('aa bb cc,11:22:33')).toEqual(['AABBCC', '112233'])
  })

  it('rejects missing, nonexistent, and directory executable paths before PowerShell', () => {
    expect(() => validateExecutablePath('')).toThrow(/Usage:/)
    expect(() => validateExecutablePath(join(tmpdir(), 'missing-Orca.exe'))).toThrow(
      /does not exist/
    )

    withTempFile((filePath, dir) => {
      expect(() => validateExecutablePath(dir)).toThrow(/not a file/)
      expect(() => validateExecutablePath(filePath)).not.toThrow()
    })
  })

  it('parses the exact JSON emitted by PowerShell', () => {
    expect(parseSignatureJson(JSON.stringify(validSignature))).toEqual(validSignature)
    expect(() => parseSignatureJson('')).toThrow(/did not return/)
    expect(() => parseSignatureJson(`${JSON.stringify(validSignature)}\nextra`)).toThrow(
      /malformed/
    )
  })

  it('accepts a valid signature with an exact normalized signer subject', () => {
    const result = classifySignature({
      ...validSignature,
      signerSubject: ' CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US '
    })

    expect(result.ok).toBe(true)
  })

  it('rejects invalid status and unexpected signer subjects', () => {
    expect(classifySignature({ ...validSignature, status: 'NotSigned' }).message).toMatch(
      /status is NotSigned/
    )
    expect(
      classifySignature({
        ...validSignature,
        signerSubject: 'CN=SignPath Foundation Test, O=SignPath Foundation, L=Vienna, C=AT'
      }).message
    ).toMatch(/Unexpected Windows inner executable signer/)
  })

  it('accepts an expected thumbprint as an alternate explicit allowlist', () => {
    expect(classifySignature({ ...validSignature, signerThumbprint: '00' }).ok).toBe(true)
    expect(
      classifySignature(
        { ...validSignature, signerSubject: 'CN=Rotated Signer, O=Rotated' },
        {
          expectedSigners: [DEFAULT_EXPECTED_SIGNER],
          expectedThumbprints: ['AABBCCDD']
        }
      ).ok
    ).toBe(true)
    expect(
      classifySignature(
        { ...validSignature, signerSubject: 'CN=Rotated Signer, O=Rotated' },
        {
          expectedSigners: [DEFAULT_EXPECTED_SIGNER],
          expectedThumbprints: ['001122']
        }
      ).message
    ).toMatch(/Unexpected Windows inner executable signer/)
    expect(
      classifySignature(validSignature, {
        expectedSigners: [DEFAULT_EXPECTED_SIGNER],
        expectedThumbprints: ['001122']
      }).ok
    ).toBe(true)
  })

  it('runs PowerShell with an argument array and fails on stderr or nonzero exit', () => {
    const calls = []
    const spawnSyncImpl = (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0, stdout: JSON.stringify(validSignature), stderr: '' }
    }

    expect(getPowerShellSignatureJson('C:\\Path With Spaces\\Orca.exe', spawnSyncImpl)).toBe(
      JSON.stringify(validSignature)
    )
    expect(calls[0].command).toBe('pwsh')
    expect(calls[0].args).toContain('-Command')
    expect(calls[0].args.at(-1)).not.toBe('C:\\Path With Spaces\\Orca.exe')
    expect(calls[0].options).toEqual(
      expect.objectContaining({
        encoding: 'utf8',
        env: expect.objectContaining({
          ORCA_WINDOWS_INNER_EXECUTABLE: 'C:\\Path With Spaces\\Orca.exe'
        })
      })
    )

    expect(() =>
      getPowerShellSignatureJson('Orca.exe', () => ({ status: 0, stdout: '{}', stderr: 'warning' }))
    ).toThrow(/stderr/)
    expect(() =>
      getPowerShellSignatureJson('Orca.exe', () => ({ status: 7, stdout: '', stderr: '' }))
    ).toThrow(/exit code 7/)
  })

  it('verifies with injected Windows platform and spawn implementation', () => {
    withTempFile((filePath) => {
      const signature = verifyWindowsInnerSignature({
        executablePath: filePath,
        platform: 'win32',
        spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify(validSignature), stderr: '' })
      })

      expect(signature).toEqual(validSignature)
    })
  })

  it('does not attempt real Authenticode verification outside Windows', () => {
    withTempFile((filePath) => {
      expect(() =>
        verifyWindowsInnerSignature({
          executablePath: filePath,
          platform: 'linux',
          spawnSyncImpl: () => {
            throw new Error('should not spawn')
          }
        })
      ).toThrow(/requires Windows/)
    })
  })
})
