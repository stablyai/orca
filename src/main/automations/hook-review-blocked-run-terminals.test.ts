import { describe, expect, it } from 'vitest'
import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'
import { closeEarlierHookReviewRunTerminals } from './hook-review-blocked-run-terminals'
import { AGENT_HOOKS_REVIEW_BLOCKED_ERROR } from './runtime-terminal-run-observer'

function makeRun(id: string, dispatchedAt: number): AutomationRun {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cleanup reads only these run fields.
  return {
    id,
    automationId: 'nightly',
    status: 'dispatch_failed',
    error: AGENT_HOOKS_REVIEW_BLOCKED_ERROR,
    terminalPaneKey: `tab-${id}:1`,
    terminalPtyId: `pty-${id}`,
    dispatchedAt,
    startedAt: dispatchedAt,
    createdAt: dispatchedAt
  } as AutomationRun
}

describe('closeEarlierHookReviewRunTerminals', () => {
  it('closes earlier tabs still on the hook review and keeps the newest one to answer in', async () => {
    const runs = ['stuck', 'typed', 'restored', 'unknown', 'answered', 'latest'].map((id, index) =>
      makeRun(id, index)
    )
    const closed: string[] = []
    const cleared: AutomationDispatchResult[] = []

    await closeEarlierHookReviewRunTerminals(
      {
        store: { listAutomationRuns: () => runs },
        runtime: {
          getTerminalHandleForPaneKey: (paneKey) => paneKey.replace(/^tab-|:1$/g, ''),
          // A cold restore put a new process in the 'restored' pane.
          getTerminalPtyIdForHandle: (handle) =>
            handle === 'restored' ? 'pty-restored-new' : `pty-${handle}`,
          readTerminalClientUse: (ptyId) =>
            ptyId === 'pty-typed' ? 'used' : ptyId === 'pty-unknown' ? 'unknown' : 'unused',
          waitForTerminal: async (handle) =>
            handle === 'answered'
              ? { satisfied: true }
              : { satisfied: false, blockedReason: 'agent-hooks-review-prompt' },
          closeTerminal: async (handle) => {
            closed.push(handle)
          }
        },
        markDispatchResult: async (result) => {
          cleared.push(result)
          return runs[0]
        }
      },
      runs[5]
    )

    expect(closed).toEqual(['stuck'])
    expect(cleared).toEqual([
      {
        runId: 'stuck',
        status: 'dispatch_failed',
        error: AGENT_HOOKS_REVIEW_BLOCKED_ERROR,
        terminalSessionId: null,
        terminalPaneKey: null,
        terminalPtyId: null
      }
    ])
  })
})
