import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { OrcaRuntimeService } from '../../orca-runtime'
import { SettingsUpdate } from './client-settings-schemas'

function runtimeWithSharing(artifactSharingEnabled: unknown): OrcaRuntimeService {
  return new OrcaRuntimeService({
    getSettings: () => ({ ...getDefaultSettings('/tmp'), artifactSharingEnabled })
  } as never)
}

// Why: the publish gate is only real if an agent cannot grant it to itself. The RPC settings
// surface — which the CLI, relay, and mobile clients all reach — must reject the key outright.
describe('artifact publish capability cannot be granted over RPC', () => {
  it('rejects settings.update attempts to turn on artifactSharingEnabled', () => {
    expect(SettingsUpdate.safeParse({ artifactSharingEnabled: true }).success).toBe(false)
  })

  it('rejects the deprecated artifactsEnabled alias too', () => {
    expect(SettingsUpdate.safeParse({ artifactsEnabled: true }).success).toBe(false)
  })

  it('still accepts an unrelated allowlisted setting', () => {
    expect(SettingsUpdate.safeParse({ compactWorktreeCards: true }).success).toBe(true)
  })

  // Reading is the other half of the contract: clients preflight the capability over settings.get
  // so a denial costs one small round trip instead of an upload-sized payload.
  it('publishes the capability read-only through settings.get', () => {
    expect(runtimeWithSharing(true).getClientSettings().artifactSharingEnabled).toBe(true)
    expect(runtimeWithSharing(false).getClientSettings().artifactSharingEnabled).toBe(false)
    expect(runtimeWithSharing(undefined).getClientSettings().artifactSharingEnabled).toBe(false)
  })

  it('reports the projection fail-closed, so a truthy disk value never reads as granted', () => {
    expect(runtimeWithSharing('yes').getClientSettings().artifactSharingEnabled).toBe(false)
  })
})
