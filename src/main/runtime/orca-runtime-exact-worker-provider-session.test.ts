import { describe, expect, it } from 'vitest'
import { wslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import { OrcaRuntimeWithGetTerminalInteractiveWait } from './terminal/wait/terminal-interactive-wait'

const PANE_KEY = 'tab:worker'
const PTY_ID = 'pty-wsl'

type ExactWorkerProviderSessionHost = {
  getExactWorkerProviderSession: (handle: string, observedAfter: number) => unknown
}

// Exercise shipping-method wiring: that was the regression, not selector logic.
function selectThroughRuntime(
  statusConnectionId: string | null,
  launch: { launchAgent?: string | null; launchConfig?: unknown } = {}
): unknown {
  const runtime = {
    getTerminalPaneKey: () => PANE_KEY,
    getTerminalProcessIncarnation: () => 'pty-wsl:inc-1',
    getTerminalAgentStatusPtyId: () => PTY_ID,
    ptysById: new Map([
      [PTY_ID, { connectionId: null, launchToken: 'launch-1', wslDistro: 'Ubuntu', ...launch }]
    ]),
    wslDistroByPtyId: new Map([[PTY_ID, 'Ubuntu']]),
    getAgentStatusSnapshotFn: () => [
      {
        paneKey: PANE_KEY,
        connectionId: statusConnectionId,
        launchToken: 'launch-1',
        agentType: 'codex',
        receivedAt: 500,
        providerSession: { key: 'session_id', id: 's1', transcriptPath: '/t.jsonl' }
      }
    ]
  }
  return (
    OrcaRuntimeWithGetTerminalInteractiveWait.prototype as unknown as ExactWorkerProviderSessionHost
  ).getExactWorkerProviderSession.call(runtime as never, 'term_wsl', 0)
}

describe('exact worker provider session wiring', () => {
  it('selects a local hook status for a local pane', () => {
    expect(selectThroughRuntime(null)).toMatchObject({
      agent: 'codex',
      providerSession: { id: 's1' }
    })
  })

  it('selects the WSL-relayed hook status for the same local pane', () => {
    expect(selectThroughRuntime(wslHookRelayConnectionId('Ubuntu'))).toMatchObject({
      agent: 'codex',
      wslDistro: 'Ubuntu',
      providerSession: { id: 's1' }
    })
  })

  it('rejects a relay from a different distro', () => {
    expect(selectThroughRuntime(wslHookRelayConnectionId('Debian'))).toBeNull()
  })

  // #37693: a reopen replays this recipe, so only the launch that still owns the pane may supply it.
  it.each([
    ['codex', true],
    [null, false]
  ])('attaches the PTY recipe when its launch agent is %s: %s', (launchAgent, attached) => {
    const launchConfig = { agentArgs: '--dangerously-bypass-approvals-and-sandbox', agentEnv: {} }
    const session = selectThroughRuntime(null, { launchAgent, launchConfig })
    expect(session).toMatchObject({ agent: 'codex' })
    expect((session as { launchConfig?: unknown }).launchConfig).toEqual(
      attached ? launchConfig : undefined
    )
  })
})
