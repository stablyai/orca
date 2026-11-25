import { describe, expect, it } from 'vitest'
import type { InitializeResponse } from '../../generated/acp-protocol.generated'
import { buildAcpStartupSetup } from './acp-handshake-setup'

describe('buildAcpStartupSetup', () => {
  const spec = { resumePreference: 'resume' as const }
  const launch = {
    env: {},
    additionalDirectories: ['/repo/extra-one', '/repo/extra-two']
  }

  it('includes additionalDirectories only when sessionCapabilities.additionalDirectories is advertised', () => {
    const supported = {
      protocolVersion: 1,
      agentCapabilities: {
        sessionCapabilities: { additionalDirectories: {} }
      }
    } as unknown as InitializeResponse

    expect(buildAcpStartupSetup(spec, launch, supported).additionalDirectories).toEqual([
      '/repo/extra-one',
      '/repo/extra-two'
    ])
  })

  it('omits additionalDirectories when agentCapabilities lack sessionCapabilities.additionalDirectories', () => {
    const unsupported = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {}
      }
    } as unknown as InitializeResponse

    expect('additionalDirectories' in buildAcpStartupSetup(spec, launch, unsupported)).toBe(false)
  })
})
