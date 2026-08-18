import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { OrcaRuntimeService } from '../../orca-runtime'
import { SettingsUpdate } from './client-ui-schemas'

vi.mock('electron', () => ({
  app: { getPath: () => '/orca-state', isPackaged: true }
}))

function runtimeWithSharing(agentSkillSharingEnabled: unknown): OrcaRuntimeService {
  return new OrcaRuntimeService({
    getSettings: () => ({ ...getDefaultSettings('/tmp'), agentSkillSharingEnabled })
  } as never)
}

describe('agent skill publish capability cannot be granted over RPC', () => {
  it('rejects settings.update attempts to enable it', () => {
    expect(SettingsUpdate.safeParse({ agentSkillSharingEnabled: true }).success).toBe(false)
  })

  it('publishes the capability read-only through settings.get', () => {
    expect(runtimeWithSharing(true).getClientSettings().agentSkillSharingEnabled).toBe(true)
    expect(runtimeWithSharing(false).getClientSettings().agentSkillSharingEnabled).toBe(false)
    expect(runtimeWithSharing(undefined).getClientSettings().agentSkillSharingEnabled).toBe(false)
  })

  it('fails closed for truthy non-booleans', () => {
    expect(runtimeWithSharing('yes').getClientSettings().agentSkillSharingEnabled).toBe(false)
  })
})
