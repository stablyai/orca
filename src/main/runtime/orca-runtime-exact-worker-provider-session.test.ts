import { describe, expect, it } from 'vitest'
import { wslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import { OrcaRuntimeWithGetTerminalInteractiveWait } from './orca-runtime-get-terminal-interactive-wait'

const PANE_KEY = 'tab:worker'
const PTY_ID = 'pty-wsl'

type ExactWorkerProviderSessionHost = {
  getExactWorkerProviderSession: (handle: string, observedAfter: number) => unknown
}

/** Drives the shipping method, not the selector helper: the wiring is what regressed. */
function selectThroughRuntime(statusConnectionId: string | null): unknown {
  const runtime = {
    getTerminalPaneKey: () => PANE_KEY,
    getTerminalProcessIncarnation: () => 'pty-wsl:inc-1',
    getTerminalAgentStatusPtyId: () => PTY_ID,
    ptysById: new Map([
      [PTY_ID, { connectionId: null, launchToken: 'launch-1', wslDistro: 'Ubuntu' }]
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
})
