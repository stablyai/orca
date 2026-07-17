import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertDisjointRuntimeBuildDirectories,
  parseBuildArguments
} from './build-ssh-relay-runtime.mjs'

const commit = 'a'.repeat(40)
const requiredArguments = [
  '--tuple',
  'darwin-arm64',
  '--inputs-directory',
  'inputs',
  '--output-directory',
  'outputs/first',
  '--work-directory',
  'outputs/build-work',
  '--source-date-epoch',
  '1752710400',
  '--git-commit',
  commit
]

describe('SSH relay runtime build isolation', () => {
  it('requires and resolves a caller-owned stable clean-build directory', () => {
    expect(parseBuildArguments(requiredArguments)).toMatchObject({
      outputDirectory: resolve('outputs/first'),
      workDirectory: resolve('outputs/build-work')
    })
    expect(() =>
      parseBuildArguments(requiredArguments.filter((value, index) => ![6, 7].includes(index)))
    ).toThrow('Missing required build argument: workDirectory')
  })

  it('rejects work/output overlap before either exclusive directory is created', () => {
    expect(() => assertDisjointRuntimeBuildDirectories('/tmp/output', '/tmp/output')).toThrow(
      'must be disjoint'
    )
    expect(() => assertDisjointRuntimeBuildDirectories('/tmp/output', '/tmp/output/work')).toThrow(
      'must be disjoint'
    )
    expect(() => assertDisjointRuntimeBuildDirectories('/tmp/output/work', '/tmp/output')).toThrow(
      'must be disjoint'
    )
    expect(() =>
      assertDisjointRuntimeBuildDirectories('/tmp/output/first', '/tmp/output/build-work')
    ).not.toThrow()
  })
})
