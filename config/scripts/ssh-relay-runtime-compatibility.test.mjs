import { describe, expect, it } from 'vitest'

import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'

describe('SSH relay runtime compatibility contract', () => {
  it('uses the manifest compatibility discriminator for both Windows tuples', () => {
    expect(sshRelayRuntimeCompatibility['win32-x64'].kind).toBe('windows')
    expect(sshRelayRuntimeCompatibility['win32-arm64'].kind).toBe('windows')
  })

  it('matches a fixed Windows canonical content-identity vector', () => {
    const identity = {
      tupleId: 'win32-x64',
      os: 'win32',
      architecture: 'x64',
      compatibility: sshRelayRuntimeCompatibility['win32-x64'],
      nodeVersion: '24.18.0',
      dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
      entries: []
    }

    expect(computeSshRelayRuntimeContentId(identity)).toBe(
      'sha256:b3eb5c89f079ed735cb83cf2595102fe010b8dd78d3096ddf592109b2ac222b0'
    )
  })
})
