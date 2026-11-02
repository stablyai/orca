import { describe, expect, it, vi } from 'vitest'
import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'
import { closeEarlierHookReviewRunTerminals } from './hook-review-blocked-run-terminals'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../runtime/agent-transcript-pane-test-harness'
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
  it('skips a previously blocked pane whose exact process ended', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'shell',
      foregroundProcess: 'bash',
      data: ''
    })
    const prior = makeRun('prior', 1)
    prior.terminalPtyId = TRANSCRIPT_PANE_PTY_ID
    const latest = makeRun('latest', 2)
    runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 137, 'inc-1', { providerExitObserved: true })
    const closeTerminal = vi.fn()
    const markDispatchResult = vi.fn()
    await closeEarlierHookReviewRunTerminals(
      {
        store: { listAutomationRuns: () => [prior, latest] },
        runtime: {
          getTerminalHandleForPaneKey: () => handle,
          getTerminalPtyIdForHandle: () => TRANSCRIPT_PANE_PTY_ID,
          readTerminalClientUse: () => 'unused',
          waitForTerminal: runtime.waitForTerminal.bind(runtime),
          closeTerminal
        },
        markDispatchResult
      },
      latest
    )
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(markDispatchResult).not.toHaveBeenCalled()
  })

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
