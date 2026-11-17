import { describe, expect, it } from 'vitest'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { runtimeBuildFields } from './runtime-build-fields'

const base: RuntimeStatus = {
  runtimeId: 'rt',
  rendererGraphEpoch: 0,
  graphStatus: 'ready',
  authoritativeWindowId: null,
  liveTabCount: 0,
  liveLeafCount: 0
}

describe('runtimeBuildFields', () => {
  it('reports the answering build and its protocol range', () => {
    expect(
      runtimeBuildFields({
        ...base,
        appVersion: '1.2.3',
        buildCommit: 'a'.repeat(40),
        runtimeProtocolVersion: 0,
        minCompatibleRuntimeClientVersion: 2
      })
    ).toEqual({
      appVersion: '1.2.3',
      buildCommit: 'a'.repeat(40),
      runtimeProtocolVersion: 0,
      minCompatibleRuntimeClientVersion: 2
    })
  })

  it('leaves out what an older host does not report', () => {
    expect(runtimeBuildFields(base)).toEqual({})
  })
})
