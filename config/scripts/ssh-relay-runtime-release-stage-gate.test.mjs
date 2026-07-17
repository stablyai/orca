import { describe, expect, it } from 'vitest'

import {
  SSH_RELAY_RUNTIME_RELEASE_LIMITS,
  evaluateSshRelayRuntimeReleaseStages
} from './ssh-relay-runtime-release-stage-gate.mjs'

const LINUX = 'linux-x64-glibc'
const WINDOWS = 'win32-x64'
const SHA = {
  linux: `sha256:${'1'.repeat(64)}`,
  windowsUnsigned: `sha256:${'2'.repeat(64)}`,
  windowsSigned: `sha256:${'3'.repeat(64)}`,
  manifest: `sha256:${'4'.repeat(64)}`,
  signature: `sha256:${'5'.repeat(64)}`
}

function asset(tupleId, name, sha256, contentDigit) {
  return {
    tupleId,
    name,
    sha256,
    contentId: `sha256:${contentDigit.repeat(64)}`,
    size: 1024
  }
}

function stage(id, output, overrides = {}) {
  return {
    id,
    outcome: 'success',
    attempts: 1,
    elapsedMs: 1_000,
    output,
    ...overrides
  }
}

function successfulFixture() {
  const linux = asset(LINUX, 'orca-ssh-relay-runtime-linux.tar.br', SHA.linux, 'a')
  const windowsUnsigned = asset(
    WINDOWS,
    'orca-ssh-relay-runtime-windows-unsigned.zip',
    SHA.windowsUnsigned,
    'b'
  )
  const windowsSigned = asset(
    WINDOWS,
    'orca-ssh-relay-runtime-windows-signed.zip',
    SHA.windowsSigned,
    'c'
  )
  const manifest = {
    name: 'orca-ssh-relay-runtime-manifest.json',
    sha256: SHA.manifest,
    size: 2048
  }
  const signature = {
    name: 'orca-ssh-relay-runtime-manifest.sig',
    sha256: SHA.signature,
    size: 64
  }
  const finalRuntimeAssets = [linux, windowsSigned]
  const releaseAssets = [...finalRuntimeAssets, manifest, signature]
  return {
    candidateTupleIds: [LINUX, WINDOWS],
    signingTupleIds: [WINDOWS],
    stages: [
      stage(`build:${LINUX}`, linux),
      stage(`build:${WINDOWS}`, windowsUnsigned),
      stage(`sign:${WINDOWS}`, {
        approval: 'approved',
        inputSha256: windowsUnsigned.sha256,
        asset: windowsSigned
      }),
      stage('aggregate', {
        inputAssets: structuredClone(finalRuntimeAssets),
        manifest: structuredClone(manifest),
        signature: structuredClone(signature)
      }),
      stage('upload', {
        inputAssets: structuredClone(releaseAssets),
        uploadedAssets: structuredClone(releaseAssets)
      }),
      stage('readback', {
        inputAssets: structuredClone(releaseAssets),
        downloadedAssets: structuredClone(releaseAssets)
      })
    ]
  }
}

function stageById(fixture, id) {
  return fixture.stages.find((entry) => entry.id === id)
}

describe('SSH relay runtime release stage gate', () => {
  it('pins finite release-stage retry and timeout ceilings', () => {
    expect(SSH_RELAY_RUNTIME_RELEASE_LIMITS).toEqual({
      build: { maxAttempts: 3, timeoutMs: 30 * 60_000 },
      sign: { maxAttempts: 1, timeoutMs: 4 * 60 * 60_000 },
      aggregate: { maxAttempts: 1, timeoutMs: 15 * 60_000 },
      upload: { maxAttempts: 3, timeoutMs: 15 * 60_000 },
      readback: { maxAttempts: 3, timeoutMs: 15 * 60_000 }
    })
  })

  it('accepts only a complete immutable build-sign-aggregate-upload-readback chain', () => {
    const result = evaluateSshRelayRuntimeReleaseStages(successfulFixture())

    expect(result.candidateTupleIds).toEqual([LINUX, WINDOWS])
    expect(result.finalRuntimeAssets.map((entry) => entry.tupleId)).toEqual([LINUX, WINDOWS])
    expect(result.releaseAssets.map((entry) => entry.name)).toEqual([
      'orca-ssh-relay-runtime-linux.tar.br',
      'orca-ssh-relay-runtime-windows-signed.zip',
      'orca-ssh-relay-runtime-manifest.json',
      'orca-ssh-relay-runtime-manifest.sig'
    ])
    expect(result.publishable).toBe(true)
  })

  it('does not invent a signing stage for a Linux-only candidate set', () => {
    const fixture = successfulFixture()
    fixture.candidateTupleIds = [LINUX]
    fixture.signingTupleIds = []
    fixture.stages = fixture.stages.filter(
      (entry) => entry.id !== `build:${WINDOWS}` && entry.id !== `sign:${WINDOWS}`
    )
    const linux = structuredClone(stageById(fixture, `build:${LINUX}`).output)
    const aggregate = stageById(fixture, 'aggregate').output
    aggregate.inputAssets = [structuredClone(linux)]
    const releaseAssets = [linux, aggregate.manifest, aggregate.signature]
    Object.assign(stageById(fixture, 'upload').output, {
      inputAssets: structuredClone(releaseAssets),
      uploadedAssets: structuredClone(releaseAssets)
    })
    Object.assign(stageById(fixture, 'readback').output, {
      inputAssets: structuredClone(releaseAssets),
      downloadedAssets: structuredClone(releaseAssets)
    })

    expect(evaluateSshRelayRuntimeReleaseStages(fixture).finalRuntimeAssets).toEqual([linux])
  })

  it('requires signing for every macOS and Windows candidate and forbids it for Linux', () => {
    const missing = successfulFixture()
    missing.signingTupleIds = []
    expect(() => evaluateSshRelayRuntimeReleaseStages(missing)).toThrow(/platform policy/i)

    const extra = successfulFixture()
    extra.signingTupleIds = [WINDOWS, LINUX]
    expect(() => evaluateSshRelayRuntimeReleaseStages(extra)).toThrow(/platform policy/i)
  })

  it.each([
    ['timed-out', 'timed out'],
    ['retry-exhausted', 'retry exhaustion'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled']
  ])('fails closed when a build is %s', (outcome, message) => {
    const fixture = successfulFixture()
    Object.assign(stageById(fixture, `build:${LINUX}`), { outcome, output: undefined })

    expect(() => evaluateSshRelayRuntimeReleaseStages(fixture)).toThrow(message)
  })

  it.each([
    ['pending', 'approval is absent'],
    ['denied', 'approval was denied'],
    ['timed-out', 'approval timed out']
  ])('fails closed when signing approval is %s', (approval, message) => {
    const fixture = successfulFixture()
    stageById(fixture, `sign:${WINDOWS}`).output.approval = approval

    expect(() => evaluateSshRelayRuntimeReleaseStages(fixture)).toThrow(message)
  })

  it('rejects signing failure, unsigned input drift, and incomplete returned output', () => {
    const failed = successfulFixture()
    Object.assign(stageById(failed, `sign:${WINDOWS}`), { outcome: 'failed', output: undefined })
    expect(() => evaluateSshRelayRuntimeReleaseStages(failed)).toThrow(/sign:win32-x64 failed/i)

    const drifted = successfulFixture()
    stageById(drifted, `sign:${WINDOWS}`).output.inputSha256 = SHA.linux
    expect(() => evaluateSshRelayRuntimeReleaseStages(drifted)).toThrow(/unsigned input/i)

    const incomplete = successfulFixture()
    delete stageById(incomplete, `sign:${WINDOWS}`).output.asset.sha256
    expect(() => evaluateSshRelayRuntimeReleaseStages(incomplete)).toThrow(/missing fields|sha256/i)
  })

  it('enforces bounded attempts and elapsed time even for success results', () => {
    const retried = successfulFixture()
    stageById(retried, 'upload').attempts = SSH_RELAY_RUNTIME_RELEASE_LIMITS.upload.maxAttempts + 1
    expect(() => evaluateSshRelayRuntimeReleaseStages(retried)).toThrow(/attempt budget/i)

    const slow = successfulFixture()
    stageById(slow, 'aggregate').elapsedMs =
      SSH_RELAY_RUNTIME_RELEASE_LIMITS.aggregate.timeoutMs + 1
    expect(() => evaluateSshRelayRuntimeReleaseStages(slow)).toThrow(/time budget/i)
  })

  it('rejects missing, duplicate, and unexpected stage results', () => {
    const missing = successfulFixture()
    missing.stages = missing.stages.filter((entry) => entry.id !== 'readback')
    expect(() => evaluateSshRelayRuntimeReleaseStages(missing)).toThrow(/missing.*readback/i)

    const duplicate = successfulFixture()
    duplicate.stages.push(structuredClone(duplicate.stages[0]))
    expect(() => evaluateSshRelayRuntimeReleaseStages(duplicate)).toThrow(/duplicate/i)

    const unexpected = successfulFixture()
    unexpected.stages.push(stage('sign:linux-x64-glibc', {}))
    expect(() => evaluateSshRelayRuntimeReleaseStages(unexpected)).toThrow(/unexpected/i)
  })

  it('rejects aggregate, upload, or read-back byte drift', () => {
    for (const [id, field] of [
      ['aggregate', 'inputAssets'],
      ['upload', 'uploadedAssets'],
      ['readback', 'downloadedAssets']
    ]) {
      const fixture = successfulFixture()
      stageById(fixture, id).output[field][0].sha256 = SHA.windowsUnsigned
      expect(() => evaluateSshRelayRuntimeReleaseStages(fixture)).toThrow(/asset.*disagree/i)
    }
  })
})
