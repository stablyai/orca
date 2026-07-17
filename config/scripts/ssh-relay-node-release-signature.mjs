import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { validateSshRelayNodeReleaseContract } from './ssh-relay-node-release-contract.mjs'

const execFileAsync = promisify(execFile)
const MAX_KEY_BYTES = 1024 * 1024
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024
const COMMAND_TIMEOUT_MS = 60 * 1000

async function readVerifiedFile(filePath, maximumBytes, expectedSha256, label) {
  const metadata = await stat(filePath)
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} exceeds its size limit or is not a regular file`)
  }

  const chunks = []
  const digest = createHash('sha256')
  let bytes = 0
  const stream = createReadStream(filePath)
  try {
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > maximumBytes) {
        throw new Error(`${label} exceeds its size limit`)
      }
      chunks.push(chunk)
      digest.update(chunk)
    }
  } catch (error) {
    stream.destroy()
    throw error
  }
  if (digest.digest('hex') !== expectedSha256) {
    throw new Error(`${label} SHA-256 does not match the pinned contract`)
  }
  return Buffer.concat(chunks, bytes)
}

async function defaultCommandRunner(command, args, { cwd } = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true
    })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (error && typeof error === 'object' && ('stdout' in error || 'stderr' in error)) {
      return {
        exitCode: typeof error.code === 'number' ? error.code : 1,
        stdout: typeof error.stdout === 'string' ? error.stdout : '',
        stderr: typeof error.stderr === 'string' ? error.stderr : String(error.message ?? error)
      }
    }
    throw error
  }
}

function validateGpgvResult(result, expectedFingerprint) {
  const status = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const fingerprints = [...status.matchAll(/\[GNUPG:\] VALIDSIG ([0-9A-F]{40})(?:\s|$)/g)].map(
    (match) => match[1]
  )
  if (fingerprints.length !== 1 || fingerprints[0] !== expectedFingerprint) {
    throw new Error('gpgv did not report exactly the pinned Node release signer fingerprint')
  }
}

export async function verifySshRelayNodeSignature(
  releaseInput,
  { checksumPath, signaturePath, keyPath, commandRunner = defaultCommandRunner }
) {
  const release = validateSshRelayNodeReleaseContract(releaseInput)
  const resolvedKeyPath = keyPath ?? release.signature.key.path
  const [keyBytes, checksumBytes, signatureBytes] = await Promise.all([
    readVerifiedFile(
      resolvedKeyPath,
      MAX_KEY_BYTES,
      release.signature.key.sha256,
      'Node release key'
    ),
    readVerifiedFile(
      checksumPath,
      release.checksumDocument.maximumBytes,
      release.checksumDocument.sha256,
      'Node checksum document'
    ),
    readVerifiedFile(
      signaturePath,
      release.signature.maximumBytes,
      release.signature.sha256,
      'Node checksum signature'
    )
  ])

  // Verify copies of the bytes we hashed so a path replacement cannot change what gpgv sees.
  const directory = await mkdtemp(join(tmpdir(), 'orca-node-signature-'))
  try {
    const armoredKeyPath = join(directory, 'release-key.asc')
    const verifiedChecksumPath = join(directory, release.checksumDocument.name)
    const verifiedSignaturePath = join(directory, release.signature.name)
    await Promise.all([
      writeFile(armoredKeyPath, keyBytes, { mode: 0o600 }),
      writeFile(verifiedChecksumPath, checksumBytes, { mode: 0o600 }),
      writeFile(verifiedSignaturePath, signatureBytes, { mode: 0o600 })
    ])

    // Git for Windows GPG treats drive-letter keyring paths as resource URLs.
    // Relative names stay inside the exclusive verified-copy directory on every platform.
    const commandOptions = { cwd: directory }
    const dearmor = await commandRunner(
      'gpg',
      ['--batch', '--yes', '--dearmor', '--output', './release-key.gpg', './release-key.asc'],
      commandOptions
    )
    if (dearmor.exitCode !== 0) {
      throw new Error(
        `gpgv key preparation failed: ${dearmor.stderr || 'gpg exited unsuccessfully'}`
      )
    }

    const verified = await commandRunner(
      'gpgv',
      [
        '--status-fd',
        '1',
        '--keyring',
        './release-key.gpg',
        `./${release.signature.name}`,
        `./${release.checksumDocument.name}`
      ],
      commandOptions
    )
    if (verified.exitCode !== 0) {
      throw new Error(
        `gpgv rejected the Node checksum signature: ${verified.stderr || 'unknown error'}`
      )
    }
    validateGpgvResult(verified, release.signature.signerFingerprint)
    return {
      signerFingerprint: release.signature.signerFingerprint,
      checksumSha256: release.checksumDocument.sha256,
      signatureSha256: release.signature.sha256,
      keySha256: release.signature.key.sha256
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
