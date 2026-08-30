import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionFileDiscovery } from './session-scanner-types'

const {
  antigravityDiscoveriesMock,
  discoverFilesMock,
  mimoCodeDiscoveriesMock,
  opencodeDiscoveriesMock
} = vi.hoisted(() => ({
  antigravityDiscoveriesMock: vi.fn(),
  discoverFilesMock: vi.fn(),
  mimoCodeDiscoveriesMock: vi.fn(),
  opencodeDiscoveriesMock: vi.fn()
}))

vi.mock('./session-scanner-discovery', () => ({ discoverFiles: discoverFilesMock }))
vi.mock('./session-scanner-opencode-sources', () => ({
  mimoCodeDiscoveries: mimoCodeDiscoveriesMock,
  opencodeDiscoveries: opencodeDiscoveriesMock
}))
vi.mock('./session-scanner-antigravity-sources', () => ({
  antigravityDiscoveries: antigravityDiscoveriesMock
}))

import { discoverAiVaultSessionSources } from './session-scanner-source-discovery'

describe('discoverAiVaultSessionSources agent filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const emptyDiscovery: SessionFileDiscovery = {
      agent: 'mimo-code',
      rootDir: '/mimocode',
      files: []
    }
    mimoCodeDiscoveriesMock.mockReturnValue([Promise.resolve(emptyDiscovery)])
    opencodeDiscoveriesMock.mockReturnValue([])
    antigravityDiscoveriesMock.mockReturnValue([])
    discoverFilesMock.mockResolvedValue({ agent: 'claude', rootDir: '/claude', files: [] })
  })

  it('starts discovery only for selected agents', async () => {
    const issues = []

    const discoveries = await discoverAiVaultSessionSources({
      options: { agents: ['mimo-code'] },
      limitPerAgent: 25,
      issues
    })

    expect(discoveries.map((discovery) => discovery.agent)).toEqual(['mimo-code'])
    expect(mimoCodeDiscoveriesMock).toHaveBeenCalledOnce()
    expect(opencodeDiscoveriesMock).not.toHaveBeenCalled()
    expect(antigravityDiscoveriesMock).not.toHaveBeenCalled()
    expect(discoverFilesMock).not.toHaveBeenCalled()
  })
})
