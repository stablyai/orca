import { describe, expect, it } from 'vitest'

import { expectedSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import { buildSshRelayRuntimeNativeSigningPlan } from './ssh-relay-runtime-native-signing-plan.mjs'
import { buildSshRelayRuntimeNativeSigningSelection } from './ssh-relay-runtime-native-signing-selection.mjs'

const DIGEST = `sha256:${'a'.repeat(64)}`

function identityFor(tupleId) {
  const os = tupleId.startsWith('linux-')
    ? 'linux'
    : tupleId.startsWith('darwin-')
      ? 'darwin'
      : 'win32'
  return {
    tupleId,
    os,
    nodeVersion: '24.18.0',
    dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
    entries: expectedSshRelayRuntimeClosureEntries(tupleId).map((entry) =>
      entry.type === 'file' ? { ...entry, size: 100, sha256: DIGEST } : entry
    )
  }
}

function windowsAssessments(identity, preservedPath) {
  return buildSshRelayRuntimeNativeSigningPlan(identity).signingCandidates.map((entry) =>
    entry.path === preservedPath
      ? {
          path: entry.path,
          sourceSha256: entry.sourceSha256,
          status: 'valid-upstream',
          signerSubject: 'CN=Microsoft Corporation',
          signerThumbprint: 'A'.repeat(40)
        }
      : { path: entry.path, sourceSha256: entry.sourceSha256, status: 'unsigned' }
  )
}

describe('SSH relay runtime native signing selection', () => {
  it('keeps Linux hash-only and official Node verification exact', () => {
    const selection = buildSshRelayRuntimeNativeSigningSelection(identityFor('linux-x64-glibc'), [])

    expect(selection.signingFiles).toEqual([])
    expect(selection.immutableVendorFiles).toEqual([
      expect.objectContaining({ path: 'bin/node', action: 'preserve-exact-bytes', sourceSize: 100 })
    ])
    expect(selection.verificationFiles).toHaveLength(3)
  })

  it('requires every macOS candidate and ignores no assessment input', () => {
    const identity = identityFor('darwin-arm64')
    const selection = buildSshRelayRuntimeNativeSigningSelection(identity, [])

    expect(selection.signingFiles.map((entry) => [entry.path, entry.action])).toEqual([
      ['node_modules/@parcel/watcher-darwin-arm64/watcher.node', 'developer-id-required'],
      ['node_modules/node-pty/build/Release/pty.node', 'developer-id-required'],
      ['node_modules/node-pty/build/Release/spawn-helper', 'developer-id-required']
    ])
    expect(() =>
      buildSshRelayRuntimeNativeSigningSelection(identity, [
        { path: selection.signingFiles[0].path, status: 'unsigned', sourceSha256: DIGEST }
      ])
    ).toThrow(/does not accept assessments/i)
  })

  it('stages only unsigned Windows candidates and preserves valid upstream identity', () => {
    const identity = identityFor('win32-x64')
    const preservedPath = 'node_modules/node-pty/build/Release/conpty/OpenConsole.exe'
    const selection = buildSshRelayRuntimeNativeSigningSelection(
      identity,
      windowsAssessments(identity, preservedPath)
    )

    expect(selection.signingFiles).toHaveLength(4)
    expect(selection.preservedUpstreamFiles).toEqual([
      expect.objectContaining({
        path: preservedPath,
        action: 'preserve-valid-upstream',
        signerSubject: 'CN=Microsoft Corporation',
        signerThumbprint: 'A'.repeat(40)
      })
    ])
    expect(selection.verificationFiles).toHaveLength(6)
  })

  it('rejects invalid Windows signature states and malformed signer identity', () => {
    const identity = identityFor('win32-arm64')
    const assessments = windowsAssessments(identity)
    assessments[0].status = 'hash-mismatch'
    expect(() => buildSshRelayRuntimeNativeSigningSelection(identity, assessments)).toThrow(
      /signature status/i
    )

    const malformedSigner = windowsAssessments(
      identity,
      'node_modules/node-pty/build/Release/conpty/OpenConsole.exe'
    )
    malformedSigner.find((entry) => entry.status === 'valid-upstream').signerThumbprint = 'bad'
    expect(() => buildSshRelayRuntimeNativeSigningSelection(identity, malformedSigner)).toThrow(
      /thumbprint/i
    )

    const controlSubject = windowsAssessments(
      identity,
      'node_modules/node-pty/build/Release/conpty/OpenConsole.exe'
    )
    controlSubject.find((entry) => entry.status === 'valid-upstream').signerSubject =
      'CN=Microsoft\nCorporation'
    expect(() => buildSshRelayRuntimeNativeSigningSelection(identity, controlSubject)).toThrow(
      /signer subject/i
    )
  })

  it('rejects assessment fields outside the exact status-qualified schema', () => {
    const identity = identityFor('win32-x64')
    const unexpected = windowsAssessments(identity)
    unexpected[0].signerSubject = 'CN=Unexpected'
    expect(() => buildSshRelayRuntimeNativeSigningSelection(identity, unexpected)).toThrow(
      /unexpected fields/i
    )

    const preserved = windowsAssessments(
      identity,
      'node_modules/node-pty/build/Release/conpty/OpenConsole.exe'
    )
    preserved.find((entry) => entry.status === 'valid-upstream').unexpected = true
    expect(() => buildSshRelayRuntimeNativeSigningSelection(identity, preserved)).toThrow(
      /unexpected fields/i
    )
  })

  it('rejects missing, duplicate, extra, and hash-mismatched assessments', () => {
    const identity = identityFor('win32-x64')
    const assessments = windowsAssessments(identity)
    expect(() =>
      buildSshRelayRuntimeNativeSigningSelection(identity, assessments.slice(1))
    ).toThrow(/missing assessment/i)

    expect(() =>
      buildSshRelayRuntimeNativeSigningSelection(identity, [assessments[0], ...assessments])
    ).toThrow(/duplicate assessment/i)

    expect(() =>
      buildSshRelayRuntimeNativeSigningSelection(identity, [
        ...assessments,
        { path: 'extra.exe', sourceSha256: DIGEST, status: 'unsigned' }
      ])
    ).toThrow(/unexpected assessment/i)

    const mismatched = structuredClone(assessments)
    mismatched[0].sourceSha256 = `sha256:${'b'.repeat(64)}`
    expect(() => buildSshRelayRuntimeNativeSigningSelection(identity, mismatched)).toThrow(
      /source hash/i
    )
  })

  it('rejects malformed authenticated size and digest metadata', () => {
    const invalidSize = identityFor('darwin-x64')
    invalidSize.entries.find((entry) => entry.role === 'node').size = -1
    expect(() => buildSshRelayRuntimeNativeSigningSelection(invalidSize, [])).toThrow(/size/i)

    const invalidDigest = identityFor('darwin-x64')
    invalidDigest.entries.find((entry) => entry.role === 'node').sha256 = 'sha256:nope'
    expect(() => buildSshRelayRuntimeNativeSigningSelection(invalidDigest, [])).toThrow(/digest/i)
  })
})
