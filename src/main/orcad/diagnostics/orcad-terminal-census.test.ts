import { expect, it, vi } from 'vitest'

vi.mock('../../daemon/providers/lifecycle/daemon-provider-state', () => ({
  countInProcessTerminals: vi.fn(),
  listLiveDaemonSessionsWithProtocol: vi.fn()
}))

import { collectOrcadTerminalCensus } from './orcad-terminal-census'

it('still counts in-process terminals when no daemon answers', async () => {
  await expect(
    collectOrcadTerminalCensus(
      0,
      async () => null,
      async () => 2
    )
  ).resolves.toEqual({
    liveSessions: null,
    startedSinceActivation: null,
    daemonProtocolVersion: null,
    inProcessSessions: 2
  })
})
