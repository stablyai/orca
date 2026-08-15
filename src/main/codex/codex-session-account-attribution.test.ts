import { describe, expect, it, vi } from 'vitest'
import { captureCodexSessionAccountAttributions } from './codex-session-account-attribution'

describe('Codex provider session account attribution', () => {
  it('captures managed and system snapshots from live Codex panes only', () => {
    const recordSessionAccount = vi.fn(() => true)
    const captured = captureCodexSessionAccountAttributions(
      [
        {
          paneKey: 'pane-managed',
          sessionId: 'session-managed',
          agentType: 'codex',
          observedInCurrentRuntime: true
        },
        {
          paneKey: 'pane-system',
          sessionId: 'session-system',
          agentType: 'codex',
          observedInCurrentRuntime: true
        },
        {
          paneKey: 'pane-claude',
          sessionId: 'session-claude',
          agentType: 'claude',
          observedInCurrentRuntime: true
        },
        { paneKey: 'pane-stale', sessionId: 'session-stale', agentType: 'codex' },
        {
          paneKey: 'pane-unbound',
          sessionId: 'session-unbound',
          agentType: 'codex',
          observedInCurrentRuntime: true
        }
      ],
      {
        getPtyIdForPaneKey: (paneKey) =>
          paneKey === 'pane-managed'
            ? 'pty-managed'
            : paneKey === 'pane-system'
              ? 'pty-system'
              : undefined,
        getPaneAccount: (ptyId) => ({
          selectionKey: 'host',
          accountId: ptyId === 'pty-managed' ? 'account-a' : null
        }),
        recordSessionAccount
      }
    )

    expect(captured).toBe(2)
    expect(recordSessionAccount.mock.calls).toEqual([
      ['session-managed', 'account-a'],
      ['session-system', null]
    ])
  })
})
