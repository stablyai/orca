import { describe, expect, it } from 'vitest'

import {
  assertSshRelayRuntimeLinuxEvidenceDirectories,
  parseSshRelayRuntimeLinuxBuildEvidenceArguments
} from './ssh-relay-runtime-linux-build-evidence.mjs'

const commit = 'a'.repeat(40)

function argumentsFor(overrides = {}) {
  const values = {
    tuple: 'linux-x64-glibc',
    inputsDirectory: '/tmp/inputs',
    outputRoot: '/tmp/outputs',
    workDirectory: '/tmp/work',
    evidenceDirectory: '/tmp/evidence',
    sourceDateEpoch: '123',
    gitCommit: commit,
    ...overrides
  }
  return [
    '--tuple',
    values.tuple,
    '--inputs-directory',
    values.inputsDirectory,
    '--output-root',
    values.outputRoot,
    '--work-directory',
    values.workDirectory,
    '--evidence-directory',
    values.evidenceDirectory,
    '--source-date-epoch',
    values.sourceDateEpoch,
    '--git-commit',
    values.gitCommit
  ]
}

describe('SSH relay Linux runtime evidence build', () => {
  it('accepts only the two declared native glibc tuples', () => {
    for (const tuple of ['linux-x64-glibc', 'linux-arm64-glibc']) {
      expect(
        parseSshRelayRuntimeLinuxBuildEvidenceArguments(argumentsFor({ tuple }))
      ).toMatchObject({ tuple, sourceDateEpoch: 123, gitCommit: commit })
    }
    expect(() =>
      parseSshRelayRuntimeLinuxBuildEvidenceArguments(argumentsFor({ tuple: 'darwin-x64' }))
    ).toThrow(/unsupported/i)
  })

  it('requires a full commit, safe epoch, and known flags', () => {
    expect(() =>
      parseSshRelayRuntimeLinuxBuildEvidenceArguments(argumentsFor({ gitCommit: 'abc' }))
    ).toThrow(/sha-1/i)
    expect(() =>
      parseSshRelayRuntimeLinuxBuildEvidenceArguments(argumentsFor({ sourceDateEpoch: '-1' }))
    ).toThrow(/epoch/i)
    expect(() =>
      parseSshRelayRuntimeLinuxBuildEvidenceArguments([...argumentsFor(), '--unexpected', 'x'])
    ).toThrow(/unknown/i)
  })

  it('keeps clean outputs, transient work, and uploaded evidence disjoint', () => {
    expect(() =>
      assertSshRelayRuntimeLinuxEvidenceDirectories({
        outputRoot: '/tmp/build',
        workDirectory: '/tmp/build/work',
        evidenceDirectory: '/tmp/evidence'
      })
    ).toThrow(/pairwise disjoint/i)
    expect(() =>
      assertSshRelayRuntimeLinuxEvidenceDirectories({
        outputRoot: '/tmp/output',
        workDirectory: '/tmp/work',
        evidenceDirectory: '/tmp/evidence'
      })
    ).not.toThrow()
  })
})
