import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const DEFAULT_EXPECTED_SIGNER =
  'CN=SignPath Foundation, O=SignPath Foundation, L=Lewes, S=Delaware, C=US'
export const INNER_SIGNATURE_REQUIRED_ENV = 'ORCA_WINDOWS_INNER_SIGNATURE_REQUIRED'

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

export function parseInnerSignatureRequired(value = process.env[INNER_SIGNATURE_REQUIRED_ENV]) {
  if (typeof value !== 'string' || value.trim() === '') {
    return false
  }

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'required'].includes(normalized)) {
    return true
  }

  if (['0', 'false', 'no', 'optional', 'soft'].includes(normalized)) {
    return false
  }

  throw new Error(`${INNER_SIGNATURE_REQUIRED_ENV} must be true or false.`)
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

export function formatSignatureFailureMessage(classification) {
  return `${classification.message}\n${formatSignatureSummary(classification.signature)}`
}

export function escapeGitHubActionsMessage(value) {
  return String(value).replace(/%/gu, '%25').replace(/\r/gu, '%0D').replace(/\n/gu, '%0A')
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

export function checkWindowsInnerSignature({
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
  return {
    ...classification,
    summary: formatSignatureSummary(signature)
  }
}

export function verifyWindowsInnerSignature(options) {
  const classification = checkWindowsInnerSignature(options)
  if (!classification.ok) {
    throw new Error(formatSignatureFailureMessage(classification))
  }

  return classification.signature
}

export function reportWindowsInnerSignatureCheck(
  classification,
  { required = false, consoleImpl = console } = {}
) {
  if (classification.ok) {
    consoleImpl.log('Verified Windows inner executable signature.')
    consoleImpl.log(classification.summary)
    return 0
  }

  if (required) {
    consoleImpl.error(formatSignatureFailureMessage(classification))
    return 1
  }

  const warning = `${classification.message} The release remains non-blocking because ${INNER_SIGNATURE_REQUIRED_ENV} is not true.`
  consoleImpl.warn(`::warning::${escapeGitHubActionsMessage(warning)}`)
  consoleImpl.log(classification.summary)
  return 0
}

export function runWindowsInnerSignatureCli(
  argv = process.argv.slice(2),
  {
    env = process.env,
    platform = process.platform,
    spawnSyncImpl = spawnSync,
    consoleImpl = console
  } = {}
) {
  try {
    const classification = checkWindowsInnerSignature({
      executablePath: argv[0],
      platform,
      spawnSyncImpl,
      expectedSigners: parseExpectedSigners(env.ORCA_WINDOWS_EXPECTED_SIGNERS),
      expectedThumbprints: parseExpectedThumbprints(env.ORCA_WINDOWS_EXPECTED_THUMBPRINTS)
    })
    const required = parseInnerSignatureRequired(env[INNER_SIGNATURE_REQUIRED_ENV])
    return reportWindowsInnerSignatureCheck(classification, { required, consoleImpl })
  } catch (error) {
    consoleImpl.error(error.message)
    return 1
  }
}

export function main(argv = process.argv.slice(2)) {
  const exitCode = runWindowsInnerSignatureCli(argv)
  if (exitCode !== 0) {
    process.exitCode = exitCode
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
