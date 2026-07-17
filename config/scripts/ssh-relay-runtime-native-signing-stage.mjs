import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { stageSshRelayRuntimeNativeSigningPayload } from './ssh-relay-runtime-native-signing-payload.mjs'
import { readSshRelayRuntimeNativeSigningIdentity } from './ssh-relay-runtime-native-signing-plan.mjs'
import { buildSshRelayRuntimeNativeSigningSelection } from './ssh-relay-runtime-native-signing-selection.mjs'
import { assessSshRelayRuntimeWindowsAuthenticode } from './ssh-relay-runtime-windows-authenticode-assessment.mjs'

const ARGUMENT_FIELDS = new Map([
  ['--identity', 'identityPath'],
  ['--runtime-directory', 'runtimeRoot'],
  ['--staging-directory', 'stagingRoot']
])

function valueAfter(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`Runtime native signing stage ${flag} requires a value`)
  }
  return value
}

export function parseSshRelayRuntimeNativeSigningStageArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const field = ARGUMENT_FIELDS.get(flag)
    if (!field) {
      throw new Error(`Unknown runtime native signing stage argument: ${flag}`)
    }
    if (result[field]) {
      throw new Error(`Duplicate runtime native signing stage argument: ${flag}`)
    }
    result[field] = resolve(valueAfter(argv, index, flag))
  }
  for (const field of ARGUMENT_FIELDS.values()) {
    if (!result[field]) {
      throw new Error(`Missing required runtime native signing stage argument: ${field}`)
    }
  }
  return result
}

export async function prepareSshRelayRuntimeNativeSigningStage({
  identity,
  runtimeRoot,
  stagingRoot,
  platform = process.platform,
  assessWindowsImpl = assessSshRelayRuntimeWindowsAuthenticode
}) {
  if (identity?.os !== platform) {
    // Why: pre-sign assessment is evidence only when the candidate executes on its target-native host.
    throw new Error(`Runtime native signing stage requires target-native host: ${identity?.os}`)
  }
  const assessments =
    platform === 'win32' ? await assessWindowsImpl({ identity, runtimeRoot, platform }) : []
  const selection = buildSshRelayRuntimeNativeSigningSelection(identity, assessments)
  const payload = await stageSshRelayRuntimeNativeSigningPayload({
    runtimeRoot,
    stagingRoot,
    selection
  })
  return {
    tupleId: selection.tupleId,
    platform: selection.platform,
    policy: selection.policy,
    assessments,
    immutableVendorFiles: selection.immutableVendorFiles,
    signingFiles: selection.signingFiles,
    preservedUpstreamFiles: selection.preservedUpstreamFiles,
    payload
  }
}

async function main() {
  const options = parseSshRelayRuntimeNativeSigningStageArguments(process.argv.slice(2))
  const identity = await readSshRelayRuntimeNativeSigningIdentity(options.identityPath)
  const report = await prepareSshRelayRuntimeNativeSigningStage({ ...options, identity })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`SSH relay runtime native signing stage failed: ${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}
