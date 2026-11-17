import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeSignerSubject, parseExpectedSigners } from './verify-windows-inner-signature.mjs'

// Smart App Control refuses to load any unsigned Windows binary, so every one we ship must be signed.

const WINDOWS_BINARY_EXTENSION = /\.(exe|dll|node)$/iu
// The orcad template's Linux/macOS addons are data for SSH hosts, not Windows binaries.
const NON_WINDOWS_ORCAD_TEMPLATE = /^resources\/orcad-template\/targets\/(?!win32-)/iu

// Third-party binaries that arrive already signed by Microsoft and are deliberately not re-signed.
export const VENDOR_SIGNERS = [
  'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
  'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
  'CN=Microsoft Windows Software Compatibility Publisher, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
]

const USAGE =
  'Usage: node config/scripts/desktop-distribution/windows/verify-windows-payload-signatures.mjs <win-unpacked dir> [--mode required|advisory]'

const POWERSHELL_PAYLOAD_SIGNATURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
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

export function findSignatureOffenders(
  signatures,
  { expectedSigners = parseExpectedSigners(), vendorSigners = VENDOR_SIGNERS } = {}
) {
  const allowed = new Set([...expectedSigners, ...vendorSigners].map(normalizeSignerSubject))
  return signatures.filter((signature) => {
    const subject = normalizeSignerSubject(signature?.signerSubject)
    return signature?.status !== 'Valid' || !allowed.has(subject)
  })
}

export function formatSignatureLine(signature) {
  const subject = normalizeSignerSubject(signature?.signerSubject) || '<none>'
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
        env: {
          ...process.env,
          ORCA_WINDOWS_SIGNATURE_ROOT: root,
          ORCA_WINDOWS_SIGNATURE_LIST: listPath
        }
      }
    )
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
  vendorSigners = VENDOR_SIGNERS
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
    offenders: findSignatureOffenders(signatures, { expectedSigners, vendorSigners })
  }
}

export function parseArgs(argv) {
  let root
  let mode = 'required'
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--mode') {
      mode = argv[++index]
    } else if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length)
    } else if (root === undefined) {
      root = arg
    } else {
      throw new Error(USAGE)
    }
  }
  if (mode !== 'required' && mode !== 'advisory') {
    throw new Error(USAGE)
  }
  return { root, mode }
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
    if (offenders.length === 0) {
      console.log(`All ${signatures.length} Windows binaries carry an expected signature.`)
      return 0
    }
    console.log(
      `${offenders.length} of ${signatures.length} Windows binaries lack an expected signature:`
    )
    for (const offender of offenders) {
      console.log(`  ${formatSignatureLine(offender)}`)
    }
    if (mode === 'advisory') {
      // Unsigned builds are expected here; Smart App Control machines will refuse to load these files.
      console.log(
        `::notice::${offenders.length} unsigned Windows binaries; Smart App Control machines will block them.`
      )
      return 0
    }
    return 1
  } catch (error) {
    console.error(error.message)
    return mode === 'advisory' ? 0 : 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
