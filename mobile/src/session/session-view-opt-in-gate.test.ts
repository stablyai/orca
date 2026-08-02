import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readDefaultSessionViewPreference } from '../storage/session-view-preferences'
import { shouldPresentSessionViewOptIn } from './session-view-opt-in-gate'

vi.mock('../storage/session-view-preferences', () => ({
  readDefaultSessionViewPreference: vi.fn()
}))

describe('session view opt-in gate', () => {
  beforeEach(() => {
    vi.mocked(readDefaultSessionViewPreference).mockReset()
  })

  it('presents when no default has ever been saved', async () => {
    vi.mocked(readDefaultSessionViewPreference).mockResolvedValue({
      value: null,
      loaded: true,
      hasStoredValue: false
    })
    await expect(shouldPresentSessionViewOptIn()).resolves.toBe(true)
  })

  it.each(['terminal', 'chat'] as const)('preserves an existing %s choice', async (value) => {
    vi.mocked(readDefaultSessionViewPreference).mockResolvedValue({
      value,
      loaded: true,
      hasStoredValue: true
    })
    await expect(shouldPresentSessionViewOptIn()).resolves.toBe(false)
  })

  it('does not overwrite an unknown stored value', async () => {
    vi.mocked(readDefaultSessionViewPreference).mockResolvedValue({
      value: null,
      loaded: true,
      hasStoredValue: true
    })
    await expect(shouldPresentSessionViewOptIn()).resolves.toBe(false)
  })

  it('does not block startup when storage is unreadable', async () => {
    vi.mocked(readDefaultSessionViewPreference).mockResolvedValue({
      value: null,
      loaded: false,
      hasStoredValue: false
    })
    await expect(shouldPresentSessionViewOptIn()).resolves.toBe(false)
  })
})
