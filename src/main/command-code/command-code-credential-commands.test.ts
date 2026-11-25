import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SavedCredentialReadability from '../credentials/saved-credential-readability'

const mocks = vi.hoisted(() => ({
  savedCredentialUnreadable: vi.fn(),
  saveCommandCodeApiKey: vi.fn(),
  hasCommandCodeApiKey: vi.fn(),
  refreshAfterCredentialChange: vi.fn()
}))

vi.mock('../credentials/saved-credential-readability', async (importOriginal) => {
  const actual = await importOriginal<typeof SavedCredentialReadability>()
  return { ...actual, savedCredentialUnreadable: mocks.savedCredentialUnreadable }
})

vi.mock('./command-code-api-key-store', () => ({
  saveCommandCodeApiKey: mocks.saveCommandCodeApiKey,
  clearCommandCodeApiKey: vi.fn(),
  hasCommandCodeApiKey: mocks.hasCommandCodeApiKey,
  commandCodeApiKeyEnvelopeFile: () => ({ path: '/nonexistent', envelopePrefix: 'orca:' })
}))

vi.mock('../ipc/accounts/credential-change-rate-limit-refresh', () => ({
  refreshAfterCredentialChange: mocks.refreshAfterCredentialChange
}))

import { saveCommandCodeApiKeyCredential } from './command-code-credential-commands'

describe('saveCommandCodeApiKeyCredential', () => {
  beforeEach(() => {
    mocks.savedCredentialUnreadable.mockReset().mockResolvedValue(undefined)
    mocks.saveCommandCodeApiKey.mockReset().mockResolvedValue(undefined)
    mocks.hasCommandCodeApiKey.mockReset().mockResolvedValue(false)
    mocks.refreshAfterCredentialChange.mockReset()
  })

  it('refuses to overwrite a key sealed by another Orca app', async () => {
    mocks.savedCredentialUnreadable.mockResolvedValue('sealed-elsewhere')
    await expect(saveCommandCodeApiKeyCredential(null, 'cc-key')).rejects.toThrow(
      /another Orca app/
    )
    expect(mocks.saveCommandCodeApiKey).not.toHaveBeenCalled()
  })

  it('saves a key when the existing credential opens here', async () => {
    mocks.hasCommandCodeApiKey.mockResolvedValue(true)
    const status = await saveCommandCodeApiKeyCredential(null, 'cc-key')
    expect(mocks.saveCommandCodeApiKey).toHaveBeenCalledWith('cc-key')
    expect(status).toEqual({ apiKeyConfigured: true })
  })
})
