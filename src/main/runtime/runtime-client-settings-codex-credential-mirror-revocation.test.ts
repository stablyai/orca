import { describe, expect, it, vi, beforeEach } from 'vitest'

const { clearMirroredCodexCredentialsMock } = vi.hoisted(() => ({
  clearMirroredCodexCredentialsMock: vi.fn()
}))

vi.mock('../codex-accounts/codex-credential-mirror-consent-revocation', () => ({
  clearMirroredCodexCredentials: clearMirroredCodexCredentialsMock
}))

vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: vi.fn()
}))

import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'

// Why: revoking mirror consent must remove the credential copies it already made, not just
// stop future ones. This is the settings-apply reaction that closes that gap on flip.
function makeController(initial: Partial<GlobalSettings>) {
  let settings = createGlobalSettingsFixture({ workspaceDir: '/w', ...initial })
  const store = {
    getSettings: () => settings,
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }
  return new RuntimeClientSettingsController(store as never)
}

describe('RuntimeClientSettingsController codex credential mirror consent revocation', () => {
  beforeEach(() => {
    clearMirroredCodexCredentialsMock.mockReset()
  })

  it('clears mirrored codex credentials when consent flips from true to false', async () => {
    const controller = makeController({ codexCredentialMirrorConsent: true })

    await controller.update({ codexCredentialMirrorConsent: false })

    expect(clearMirroredCodexCredentialsMock).toHaveBeenCalledOnce()
  })

  it('does not clear anything when consent flips from false to true', async () => {
    const controller = makeController({ codexCredentialMirrorConsent: false })

    await controller.update({ codexCredentialMirrorConsent: true })

    expect(clearMirroredCodexCredentialsMock).not.toHaveBeenCalled()
  })

  it('does not clear anything for an unrelated settings update', async () => {
    const controller = makeController({ codexCredentialMirrorConsent: true })

    await controller.update({ defaultTuiAgent: 'codex' })

    expect(clearMirroredCodexCredentialsMock).not.toHaveBeenCalled()
  })

  // Why: clearMirroredCodexCredentials is itself idempotent (rmSync with force), but the old
  // true->false-only gate meant a retry never ran a second time -- a false->false apply (Settings
  // saved again, or a settled default reapplied) left orphaned copies if the first clear was
  // interrupted (crash, disk full) partway through (G1).
  it('retries the clear on a false->false apply, in case files from an interrupted clear remain', async () => {
    const controller = makeController({ codexCredentialMirrorConsent: false })

    await controller.update({ codexCredentialMirrorConsent: false })

    expect(clearMirroredCodexCredentialsMock).toHaveBeenCalledOnce()
  })
})
