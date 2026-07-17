import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  verifySshRelayRuntimeNativeSigningInput,
  verifySshRelayRuntimeNativeSigningReturn
} from './ssh-relay-runtime-native-signing-payload.mjs'
import { readSshRelayRuntimeNativeSigningIdentity } from './ssh-relay-runtime-native-signing-plan.mjs'
import { readSshRelayRuntimeNativeSigningStageReport } from './ssh-relay-runtime-native-signing-stage-report.mjs'

const CODESIGN_PATH = '/usr/bin/codesign'
const CODESIGN_TIMEOUT_MS = 2 * 60_000
const CODESIGN_OUTPUT_BYTES = 64 * 1024
const SIGNING_IDENTITY_PATTERN = /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/u

function localPath(root, portablePath) {
  return resolve(root, ...portablePath.split('/'))
}

function outputBytes(result) {
  return Buffer.byteLength(result?.stdout ?? '') + Buffer.byteLength(result?.stderr ?? '')
}

export async function signSshRelayRuntimeMacosPayload({
  stagingRoot,
  selection,
  signingIdentity,
  platform = process.platform,
  spawnSyncImpl = spawnSync
}) {
  if (platform !== 'darwin' || selection.platform !== 'darwin') {
    throw new Error('Runtime macOS signing requires a target-native Darwin payload')
  }
  if (!SIGNING_IDENTITY_PATTERN.test(signingIdentity ?? '')) {
    throw new Error('Runtime macOS signing requires an exact Developer ID Application identity')
  }
  await verifySshRelayRuntimeNativeSigningInput({ stagingRoot, selection })
  for (const entry of selection.signingFiles) {
    const result = spawnSyncImpl(
      CODESIGN_PATH,
      [
        '--force',
        '--sign',
        signingIdentity,
        '--options',
        'runtime',
        '--timestamp',
        localPath(stagingRoot, entry.path)
      ],
      {
        encoding: 'utf8',
        maxBuffer: CODESIGN_OUTPUT_BYTES,
        timeout: CODESIGN_TIMEOUT_MS,
        windowsHide: true
      }
    )
    if (result?.error) {
      throw new Error(`Runtime macOS signing command failed: ${result.error.message}`)
    }
    if (result?.status !== 0 || outputBytes(result) > CODESIGN_OUTPUT_BYTES) {
      throw new Error(
        `Runtime macOS signing command failed for ${entry.path}: ${result?.status ?? '<unknown>'}`
      )
    }
  }
  return verifySshRelayRuntimeNativeSigningReturn({ returnedRoot: stagingRoot, selection })
}

const ARGUMENT_FIELDS = new Map([
  ['--identity', 'identityPath'],
  ['--signing-stage-report', 'stageReportPath'],
  ['--staging-directory', 'stagingRoot'],
  ['--signing-identity', 'signingIdentity']
])

export function parseSshRelayRuntimeMacosSigningArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const field = ARGUMENT_FIELDS.get(flag)
    const value = argv[index + 1]
    if (!field || !value || value.startsWith('--') || result[field]) {
      throw new Error(`Invalid runtime macOS signing argument: ${flag}`)
    }
    result[field] = field === 'signingIdentity' ? value : resolve(value)
  }
  if (Object.keys(result).length !== ARGUMENT_FIELDS.size) {
    throw new Error('Runtime macOS signing requires identity, report, staging, and signer')
  }
  return result
}

async function main() {
  const options = parseSshRelayRuntimeMacosSigningArguments(process.argv.slice(2))
  const identity = await readSshRelayRuntimeNativeSigningIdentity(options.identityPath)
  const { selection } = await readSshRelayRuntimeNativeSigningStageReport(
    options.stageReportPath,
    identity
  )
  const result = await signSshRelayRuntimeMacosPayload({ ...options, selection })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`SSH relay runtime macOS signing failed: ${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}

export const SSH_RELAY_RUNTIME_MACOS_SIGNING_LIMITS = Object.freeze({
  commandTimeoutMs: CODESIGN_TIMEOUT_MS,
  maximumCommandOutputBytes: CODESIGN_OUTPUT_BYTES
})
