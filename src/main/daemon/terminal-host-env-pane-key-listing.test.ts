import { describe, expect, it, vi } from 'vitest'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { TerminalHost } from './terminal-host'

vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: vi.fn()
}))

const SPAWN_PANE_KEY = '0d873f62-3000-4000-8000-000000000001:909a6659-3000-4000-8000-000000000002'
const ADOPTING_PANE_KEY =
  '4fcd5a71-3000-4000-8000-000000000003:ae74b5ec-3000-4000-8000-000000000004'

const streamClient = () => ({ onData: vi.fn(), onExit: vi.fn() })

describe('TerminalHost listing of the pane key a session exported', () => {
  it('keeps reporting the spawn-time ORCA_PANE_KEY after a reattach from another pane', async () => {
    const handle = createMockSubprocess()
    const host = new TerminalHost({ spawnSubprocess: () => handle })
    const sessionId = 'wt-1@@survivor'
    await host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      env: { ORCA_PANE_KEY: SPAWN_PANE_KEY },
      streamClient: streamClient()
    })
    // A relaunched app reattaches from the tab it minted; the shell's env never changes.
    await host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      env: { ORCA_PANE_KEY: ADOPTING_PANE_KEY },
      streamClient: streamClient()
    })

    expect(host.listSessions()).toMatchObject([{ sessionId, envPaneKey: SPAWN_PANE_KEY }])
    handle._simulateExit(0)
    await host.dispose()
  })
})
