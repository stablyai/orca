import { readFile, stat } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

import { buildSshRelayRuntimeNativeSigningSelection } from './ssh-relay-runtime-native-signing-selection.mjs'

const MAX_STAGE_REPORT_BYTES = 4 * 1024 * 1024

function expectedReport(identity, report) {
  const selection = buildSshRelayRuntimeNativeSigningSelection(identity, report.assessments)
  const stagedFiles = selection.signingFiles.map(({ path, sourceSha256, sourceSize }) => ({
    path,
    sourceSha256,
    sourceSize
  }))
  return {
    tupleId: selection.tupleId,
    platform: selection.platform,
    policy: selection.policy,
    assessments: report.assessments,
    immutableVendorFiles: selection.immutableVendorFiles,
    signingFiles: selection.signingFiles,
    preservedUpstreamFiles: selection.preservedUpstreamFiles,
    payload: {
      tupleId: selection.tupleId,
      stagingRequired: selection.signingFiles.length > 0,
      stagedFiles,
      stagedSize: stagedFiles.reduce((total, entry) => total + entry.sourceSize, 0)
    }
  }
}

export function parseSshRelayRuntimeNativeSigningStageReport(identity, report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Runtime native signing stage report must be an object')
  }
  const expected = expectedReport(identity, report)
  if (!isDeepStrictEqual(report, expected)) {
    // Why: the signing stage crosses credentialed jobs and must remain bound to source hashes.
    throw new Error('Runtime native signing stage report disagrees with its authenticated identity')
  }
  return {
    selection: {
      tupleId: expected.tupleId,
      platform: expected.platform,
      policy: expected.policy,
      immutableVendorFiles: expected.immutableVendorFiles,
      signingFiles: expected.signingFiles,
      preservedUpstreamFiles: expected.preservedUpstreamFiles,
      verificationFiles: buildSshRelayRuntimeNativeSigningSelection(identity, expected.assessments)
        .verificationFiles
    },
    payload: expected.payload,
    assessments: expected.assessments
  }
}

export async function readSshRelayRuntimeNativeSigningStageReport(path, identity) {
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_STAGE_REPORT_BYTES) {
    throw new Error('Runtime native signing stage report must be one bounded regular file')
  }
  let report
  try {
    report = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`Runtime native signing stage report is not valid JSON: ${error.message}`)
  }
  return parseSshRelayRuntimeNativeSigningStageReport(identity, report)
}

export const SSH_RELAY_RUNTIME_NATIVE_SIGNING_STAGE_REPORT_LIMITS = Object.freeze({
  maximumBytes: MAX_STAGE_REPORT_BYTES
})
