import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseExpectedSigners } from './verify-windows-inner-signature.mjs'

// Smart App Control refuses to load any unsigned Windows binary, so every one we ship must be signed.

const WINDOWS_BINARY_EXTENSION = /\.(exe|dll|node)$/iu
// The orcad template's Linux/macOS addons are data for SSH hosts, not Windows binaries.
const NON_WINDOWS_ORCAD_TEMPLATE = /^resources\/orcad-template\/targets\/(?!win32-)/iu

const SCRIPT_PATH =
  'config/scripts/desktop-distribution/windows/verify-windows-payload-signatures.mjs'

// Third-party binaries that arrive already signed by Microsoft; release staging skips them, so they are never re-signed.
// Matched on CN and O only, so a certificate renewal that changes address fields cannot block a cut.
export const VENDOR_IDENTITIES = [
  { CN: 'Microsoft Corporation', O: 'Microsoft Corporation' },
  { CN: 'Microsoft Windows', O: 'Microsoft Corporation' },
  { CN: 'Microsoft Windows Software Compatibility Publisher', O: 'Microsoft Corporation' }
]

export const POWERSHELL_TIMEOUT_MS = 10 * 60 * 1000

const USAGE = `Usage: node ${SCRIPT_PATH} <win-unpacked dir> [--mode required|advisory] [--summary <file>]`

const VENDOR_HINT =
  `A file validly signed by another vendor is skipped by release staging, so it is never re-signed. ` +
  `To ship it under that vendor's signature, add the signer's CN and O to VENDOR_IDENTITIES in ${SCRIPT_PATH}.`

const POWERSHELL_PAYLOAD_SIGNATURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = $env:ORCA_WINDOWS_SIGNATURE_ROOT
$rows = Get-Content -LiteralPath $env:ORCA_WINDOWS_SIGNATURE_LIST -Encoding utf8 |
  Where-Object { $_ -ne '' } |
  ForEach-Object {
    $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $root $_)
    [pscustomobject]@{
      path = $_
      status = $signature.Status.ToString()
      signerSubject = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Subject }
    }
  }
ConvertTo-Json -InputObject @($rows) -Compress
`

/** `relativePath` uses forward slashes. */
export function isWindowsPayloadBinary(relativePath) {
  return (
    WINDOWS_BINARY_EXTENSION.test(relativePath) && !NON_WINDOWS_ORCAD_TEMPLATE.test(relativePath)
  )
}

export function listWindowsPayloadBinaries(root, relativeDir = '') {
  const found = []
  for (const entry of readdirSync(join(root, relativeDir), { withFileTypes: true })) {
    const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...listWindowsPayloadBinaries(root, relativePath))
    } else if (entry.isFile() && isWindowsPayloadBinary(relativePath)) {
      found.push(relativePath)
    }
  }
  return found.sort()
}

export function parsePayloadSignatureJson(stdout, expectedCount) {
  const trimmed = typeof stdout === 'string' ? stdout.trim() : ''
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`PowerShell returned malformed signature JSON: ${error.message}`)
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedCount) {
    throw new Error(
      `PowerShell returned ${Array.isArray(parsed) ? parsed.length : 'no'} signatures for ${expectedCount} files.`
    )
  }
  return parsed
}

/** Split an X.500 subject into its attributes; a repeated key maps to null so it can never match. */
export function parseDistinguishedName(subject) {
  const attributes = new Map()
  if (typeof subject !== 'string') {
    return attributes
  }
  // Values may be quoted ("Foo, Inc.") or contain backslash-escaped commas.
  const pattern = /\s*([A-Za-z][\w.]*)\s*=\s*("(?:[^"\\]|\\.)*"|(?:[^,\\]|\\.)*)\s*(?:,|$)/gy
  let match
  while ((match = pattern.exec(subject)) !== null && match[0] !== '') {
    const key = match[1].toUpperCase()
    let value = match[2].trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1)
    }
    value = value.replace(/\\(.)/g, '$1')
    attributes.set(key, attributes.has(key) ? null : value)
  }
  return attributes
}

/** Our own signer is matched on CN alone, like the other release checks, but exactly rather than by substring. */
export function expectedSignerIdentities(expectedSigners = parseExpectedSigners()) {
  return expectedSigners
    .map((subject) => parseDistinguishedName(subject).get('CN'))
    .filter((cn) => typeof cn === 'string' && cn !== '')
    .map((cn) => ({ CN: cn }))
}

export function subjectMatchesIdentity(subject, identity) {
  const attributes = parseDistinguishedName(subject)
  return Object.entries(identity).every(([key, value]) => attributes.get(key) === value)
}

export function findSignatureOffenders(
  signatures,
  { expectedSigners = parseExpectedSigners(), vendorIdentities = VENDOR_IDENTITIES } = {}
) {
  const allowed = [...expectedSignerIdentities(expectedSigners), ...vendorIdentities]
  return signatures.filter(
    (signature) =>
      signature?.status !== 'Valid' ||
      !allowed.some((identity) => subjectMatchesIdentity(signature?.signerSubject, identity))
  )
}

export function formatSignatureLine(signature) {
  const subject = typeof signature?.signerSubject === 'string' ? signature.signerSubject : '<none>'
  return `${String(signature?.status ?? '<missing>').padEnd(14)} ${signature?.path}  <${subject}>`
}

// One PowerShell process for the whole payload, not one per file.
export function readPayloadSignatures(root, relativePaths, spawnSyncImpl = spawnSync) {
  const listDir = mkdtempSync(join(tmpdir(), 'orca-payload-signatures-'))
  try {
    const listPath = join(listDir, 'files.txt')
    writeFileSync(listPath, relativePaths.join('\n'), 'utf8')
    const result = spawnSyncImpl(
      'pwsh',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_PAYLOAD_SIGNATURE_SCRIPT],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: POWERSHELL_TIMEOUT_MS,
        env: {
          ...process.env,
          ORCA_WINDOWS_SIGNATURE_ROOT: root,
          ORCA_WINDOWS_SIGNATURE_LIST: listPath
        }
      }
    )
    if (result.error?.code === 'ETIMEDOUT') {
      throw new Error(
        `PowerShell signature check timed out after ${POWERSHELL_TIMEOUT_MS / 60000} minutes.`
      )
    }
    if (result.error) {
      throw result.error
    }
    if (result.status !== 0) {
      throw new Error(
        `PowerShell signature check failed with exit code ${result.status ?? '<unknown>'}: ${result.stderr?.trim() ?? ''}`
      )
    }
    return parsePayloadSignatureJson(result.stdout, relativePaths.length)
  } finally {
    rmSync(listDir, { recursive: true, force: true })
  }
}

export function verifyWindowsPayloadSignatures({
  root,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  expectedSigners = parseExpectedSigners(),
  vendorIdentities = VENDOR_IDENTITIES
}) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error(USAGE)
  }
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Windows payload directory does not exist: ${root}`)
  }
  if (platform !== 'win32') {
    throw new Error('Windows payload signature verification requires Windows.')
  }
  const relativePaths = listWindowsPayloadBinaries(root)
  if (relativePaths.length === 0) {
    throw new Error(`No Windows binaries found under ${root}; the payload layout changed?`)
  }
  const signatures = readPayloadSignatures(root, relativePaths, spawnSyncImpl)
  return {
    signatures,
    offenders: findSignatureOffenders(signatures, { expectedSigners, vendorIdentities })
  }
}

export function parseArgs(argv) {
  let root
  let mode = 'required'
  let summaryPath
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--mode') {
      mode = argv[++index]
    } else if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length)
    } else if (arg === '--summary') {
      summaryPath = argv[++index]
    } else if (root === undefined) {
      root = arg
    } else {
      throw new Error(USAGE)
    }
  }
  if ((mode !== 'required' && mode !== 'advisory') || summaryPath === '') {
    throw new Error(USAGE)
  }
  return { root, mode, summaryPath }
}

/** Exit 0 when clean (or advisory), 1 when required and offenders exist, 2 when the check could not run. */
export function main(argv = process.argv.slice(2), deps = {}) {
  let mode = 'required'
  try {
    const parsed = parseArgs(argv)
    mode = parsed.mode
    const { signatures, offenders } = verifyWindowsPayloadSignatures({
      root: parsed.root,
      ...deps
    })
    if (parsed.summaryPath) {
      writeFileSync(
        parsed.summaryPath,
        JSON.stringify({ checked: signatures.length, offenders: offenders.length })
      )
    }
    if (offenders.length === 0) {
      console.log(
        `All ${signatures.length} Windows binaries in the payload carry a trusted signature.`
      )
      return 0
    }
    console.log(
      `${offenders.length} of ${signatures.length} Windows binaries lack a trusted signature:`
    )
    for (const offender of offenders) {
      console.log(`  ${formatSignatureLine(offender)}`)
    }
    if (mode === 'advisory') {
      // Unsigned builds are expected here; Smart App Control machines will refuse to load these files.
      console.log(
        `::notice::${offenders.length} Windows binaries lack a trusted signature; Smart App Control machines will block them.`
      )
      return 0
    }
    console.log(VENDOR_HINT)
    return 1
  } catch (error) {
    console.error(error.message)
    return mode === 'advisory' ? 0 : 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
