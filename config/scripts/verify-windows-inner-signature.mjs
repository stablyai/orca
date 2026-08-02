import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const DEFAULT_EXPECTED_SIGNER =
  'CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US'

const POWERSHELL_SIGNATURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -FilePath $env:ORCA_WINDOWS_INNER_EXECUTABLE
$certificate = $signature.SignerCertificate
[pscustomobject]@{
  status = $signature.Status.ToString()
  statusMessage = $signature.StatusMessage
  signerSubject = if ($null -eq $certificate) { $null } else { $certificate.Subject }
  signerIssuer = if ($null -eq $certificate) { $null } else { $certificate.Issuer }
  signerThumbprint = if ($null -eq $certificate) { $null } else { $certificate.Thumbprint }
  notBefore = if ($null -eq $certificate) { $null } else { $certificate.NotBefore.ToString('o') }
  notAfter = if ($null -eq $certificate) { $null } else { $certificate.NotAfter.ToString('o') }
} | ConvertTo-Json -Compress
`

export function normalizeSignerSubject(subject) {
  if (typeof subject !== 'string') {
    return ''
  }

  return subject
    .split(',')
    .map((part) => part.trim().replace(/\s*=\s*/u, '='))
    .filter(Boolean)
    .join(', ')
}

export function normalizeThumbprint(thumbprint) {
  if (typeof thumbprint !== 'string') {
    return ''
  }

  return thumbprint.replace(/[^0-9a-f]/giu, '').toUpperCase()
}

export function parseExpectedSigners(value = process.env.ORCA_WINDOWS_EXPECTED_SIGNERS) {
  const source = typeof value === 'string' && value.trim() !== '' ? value : DEFAULT_EXPECTED_SIGNER

  return source
    .split(/[\r\n;]+/u)
    .map(normalizeSignerSubject)
    .filter(Boolean)
}

export function parseExpectedThumbprints(value = process.env.ORCA_WINDOWS_EXPECTED_THUMBPRINTS) {
  if (typeof value !== 'string' || value.trim() === '') {
    return []
  }

  return value
    .split(/[\r\n,;]+/u)
    .map(normalizeThumbprint)
    .filter(Boolean)
}

export function parseSignatureJson(stdout) {
  const trimmed = typeof stdout === 'string' ? stdout.trim() : ''
  if (trimmed === '') {
    throw new Error('PowerShell did not return signature JSON.')
  }

  try {
    return JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`PowerShell returned malformed signature JSON: ${error.message}`)
  }
}

export function classifySignature(signature, options = {}) {
  const expectedSigners = options.expectedSigners ?? parseExpectedSigners()
  const expectedThumbprints = options.expectedThumbprints ?? parseExpectedThumbprints()
  const status = typeof signature?.status === 'string' ? signature.status : ''
  const signerSubject = normalizeSignerSubject(signature?.signerSubject)
  const signerThumbprint = normalizeThumbprint(signature?.signerThumbprint)
  const subjectAllowed = expectedSigners.includes(signerSubject)
  const thumbprintAllowed =
    expectedThumbprints.length > 0 &&
    signerThumbprint !== '' &&
    expectedThumbprints.includes(signerThumbprint)

  if (status !== 'Valid') {
    return {
      ok: false,
      message: `Windows inner executable signature status is ${status || '<missing>'}.`,
      signature
    }
  }

  if (!subjectAllowed && !thumbprintAllowed) {
    return {
      ok: false,
      message: `Unexpected Windows inner executable signer: ${signerSubject || '<missing>'}.`,
      signature
    }
  }

  return { ok: true, signature }
}

export function formatSignatureSummary(signature) {
  return [
    `Status: ${signature.status ?? '<missing>'}`,
    `Subject: ${normalizeSignerSubject(signature.signerSubject) || '<missing>'}`,
    `Issuer: ${signature.signerIssuer ?? '<missing>'}`,
    `Thumbprint: ${normalizeThumbprint(signature.signerThumbprint) || '<missing>'}`,
    `NotBefore: ${signature.notBefore ?? '<missing>'}`,
    `NotAfter: ${signature.notAfter ?? '<missing>'}`
  ].join('\n')
}

export function validateExecutablePath(executablePath) {
  if (typeof executablePath !== 'string' || executablePath.trim() === '') {
    throw new Error('Usage: node config/scripts/verify-windows-inner-signature.mjs <Orca.exe>')
  }

  if (!existsSync(executablePath)) {
    throw new Error(`Windows inner executable does not exist: ${executablePath}`)
  }

  if (!statSync(executablePath).isFile()) {
    throw new Error(`Windows inner executable path is not a file: ${executablePath}`)
  }
}

export function getPowerShellSignatureJson(executablePath, spawnSyncImpl = spawnSync) {
  // Why: pwsh -Command does not reliably expose trailing process args to string commands.
  const result = spawnSyncImpl(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      POWERSHELL_SIGNATURE_SCRIPT
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ORCA_WINDOWS_INNER_EXECUTABLE: executablePath
      }
    }
  )

  if (result.error) {
    throw result.error
  }

  if (result.stderr?.trim()) {
    throw new Error(`PowerShell wrote to stderr while checking signature:\n${result.stderr.trim()}`)
  }

  if (result.status !== 0) {
    throw new Error(
      `PowerShell signature check failed with exit code ${result.status ?? '<unknown>'}.`
    )
  }

  return result.stdout
}

export function verifyWindowsInnerSignature({
  executablePath,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  expectedSigners = parseExpectedSigners(),
  expectedThumbprints = parseExpectedThumbprints()
}) {
  validateExecutablePath(executablePath)

  if (platform !== 'win32') {
    throw new Error('Windows inner executable signature verification requires Windows.')
  }

  const signature = parseSignatureJson(getPowerShellSignatureJson(executablePath, spawnSyncImpl))
  const classification = classifySignature(signature, { expectedSigners, expectedThumbprints })
  if (!classification.ok) {
    throw new Error(`${classification.message}\n${formatSignatureSummary(signature)}`)
  }

  return signature
}

export function main(argv = process.argv.slice(2)) {
  try {
    const signature = verifyWindowsInnerSignature({ executablePath: argv[0] })
    console.log('Verified Windows inner executable signature.')
    console.log(formatSignatureSummary(signature))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
