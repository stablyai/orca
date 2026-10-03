import { describe, expect, it, vi } from 'vitest'

const UBUNTU = '\\\\wsl.localhost\\Ubuntu\\home\\u\\.local\\share\\orca\\claude-profiles\\a\\home'
const ARCH = UBUNTU.replace('Ubuntu', 'Arch')
const mocks = vi.hoisted(() => ({
  adoption: vi.fn(async (input: { candidateAccountHomes: string[] }) => input),
  filter: vi.fn(async (paths: readonly string[]) =>
    paths.filter((path) => !path.includes('\\Arch\\'))
  )
}))
vi.mock('../claude-accounts/claude-profile-routing-authority', () => ({
  getClaudeProfileRoutingAuthority: () => ({ historyRoots: () => ['/host/.claude', UBUNTU, ARCH] })
}))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: mocks.filter
}))
vi.mock('../native-chat/structured-agent-session-history-adoption', () => ({
  findCommittedStructuredAgentSessionAdoptionReplay: vi.fn(),
  findConflictingStructuredAdoption: vi.fn(() => null),
  resolveStructuredAgentSessionAdoption: mocks.adoption,
  structuredAdoptionConflictError: vi.fn()
}))

import { resolveStructuredAgentSessionAdoptionForCreate } from './structured-agent-session-create-adoption'

describe('structured Claude adoption candidates', () => {
  it('drops WSL profile homes of distros that are not running', async () => {
    await resolveStructuredAgentSessionAdoptionForCreate({
      host: null,
      settings: {},
      agent: 'claude',
      providerSessionId: 'session',
      selfSessionId: 'self',
      selectedAccountHomePath: '/host/selected'
    })
    expect(mocks.adoption).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateAccountHomes: ['/host/selected', '/host/.claude', UBUNTU]
      })
    )
  })
})
