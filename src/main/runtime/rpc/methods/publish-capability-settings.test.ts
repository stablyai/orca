import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { SettingsUpdate } from '../../../../shared/rpc-contract/client-settings-params'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeStore } from '../../runtime-store-contract'
import { partialRuntimeStore } from '../../runtime-store-partial-fixture'
import { SharingUnavailableOnHostError } from '../../../../shared/sharing-unavailable-on-host'

vi.mock('electron', () => ({
  app: { getPath: () => '/orca-state', isPackaged: true }
}))

const CAPABILITIES = ['artifactSharingEnabled', 'agentSkillSharingEnabled'] as const

function runtimeWithSharing(
  capability: (typeof CAPABILITIES)[number],
  value: unknown
): OrcaRuntimeService {
  const store: Pick<RuntimeStore, 'getSettings'> = {
    getSettings: () => {
      const settings = getDefaultSettings('/tmp')
      // Persisted settings may contain non-booleans despite the declared schema.
      Reflect.set(settings, capability, value)
      return settings
    }
  }
  const runtime = new OrcaRuntimeService(partialRuntimeStore(store))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settings.get only checks that a service is registered, never calls it.
  runtime.setArtifactService({} as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above, presence only.
  runtime.setSkillCloudService({} as never)
  return runtime
}

// A client may read the host's publish permissions, but cannot grant them over RPC.
describe.each(CAPABILITIES)('%s cannot be granted over RPC', (capability) => {
  it('rejects settings.update attempts to enable it', () => {
    expect(SettingsUpdate.safeParse({ [capability]: true }).success).toBe(false)
  })

  it('publishes the capability read-only through settings.get', () => {
    expect(runtimeWithSharing(capability, true).getClientSettings()[capability]).toBe(true)
    expect(runtimeWithSharing(capability, false).getClientSettings()[capability]).toBe(false)
    expect(runtimeWithSharing(capability, undefined).getClientSettings()[capability]).toBe(false)
  })

  it('fails closed for truthy non-booleans', () => {
    expect(runtimeWithSharing(capability, 'yes').getClientSettings()[capability]).toBe(false)
  })
})

// #33593: a headless host registers no cloud service, so its unset toggle must not read as "off".
it('omits the toggles on a host with no sharing service so clients reach its named refusal', () => {
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({ getSettings: () => getDefaultSettings('/tmp') })
  )

  const settings = runtime.getClientSettings()

  expect(settings).not.toHaveProperty('artifactSharingEnabled')
  expect(settings).not.toHaveProperty('agentSkillSharingEnabled')
  expect(() => runtime.assertAgentSkillSharingAllowed()).toThrow(SharingUnavailableOnHostError)
})

describe('publish capability settings schema', () => {
  it('rejects the deprecated artifactsEnabled alias too', () => {
    expect(SettingsUpdate.safeParse({ artifactsEnabled: true }).success).toBe(false)
  })

  it('still accepts an unrelated allowlisted setting', () => {
    expect(SettingsUpdate.safeParse({ compactWorktreeCards: true }).success).toBe(true)
  })
})
