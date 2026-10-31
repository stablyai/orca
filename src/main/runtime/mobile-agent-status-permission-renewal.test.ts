import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { AGENT_STATUS_STALE_AFTER_MS, type AgentStatusEntry } from '../../shared/agent-status-types'

// Captured Claude 2.1.234 permission prompt: title settles 39ms before PermissionRequest, then repaints 123ms after.
// The same-class repaint advances title time without invalidating the still-live hook; 31s of silence follows.
const SETTLE_AFTER_HOOK_MS = -39
const TRAILING_TITLE_AFTER_HOOK_MS = 123

type TitleRenewal = (
  status: AgentStatusEntry | null,
  pty: unknown,
  options?: { preserveQuestionUnderShellTitle?: boolean }
) => AgentStatusEntry | null

function renewFromPtyTitle(): TitleRenewal {
  const runtime = new OrcaRuntimeService()
  const renew = (runtime as unknown as { renewMobileAgentStatusFromPtyTitle: TitleRenewal })
    .renewMobileAgentStatusFromPtyTitle
  return (status, pty, options) => renew.call(runtime, status, pty, options ?? {})
}

function claudeStatus(state: AgentStatusEntry['state'], updatedAt: number): AgentStatusEntry {
  return {
    state,
    prompt: 'Use the Write tool to create probe2.txt',
    updatedAt,
    stateStartedAt: updatedAt,
    agentType: 'claude',
    paneKey: 'tab-1:leaf-1',
    terminalTitle: '✳ probe2.txt Write tool file',
    stateHistory: []
  }
}

function parkedOnPromptPty(hookAt: number) {
  return {
    ptyId: 'pty-1',
    lastAgentStatus: 'idle',
    lastOscTitle: '✳ probe2.txt Write tool file',
    lastOscTitleEpochMs: hookAt + TRAILING_TITLE_AFTER_HOOK_MS,
    lastAgentStatusRichInvalidatedAtEpochMs: hookAt + SETTLE_AFTER_HOOK_MS,
    lastAgentStatusStartedAtEpochMs: hookAt + SETTLE_AFTER_HOOK_MS,
    title: '✳ probe2.txt Write tool file',
    worktreeId: 'wt-1'
  }
}

describe('mobile/paired projection for a pane pending a human answer', () => {
  // Claude normalizes PermissionRequest to waiting; blocked-only coverage misses its real prompts.
  it.each(['waiting', 'blocked'] as const)(
    'keeps a fresh `%s` instead of publishing a title-derived done',
    (state) => {
      const hookAt = Date.now()
      const out = renewFromPtyTitle()(claudeStatus(state, hookAt), parkedOnPromptPty(hookAt), {
        preserveQuestionUnderShellTitle: true
      })
      expect(out?.state).toBe(state)
    }
  )

  it('still lets the title retire a `waiting` older than the stale boundary', () => {
    const hookAt = Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1
    const out = renewFromPtyTitle()(claudeStatus('waiting', hookAt), parkedOnPromptPty(hookAt), {
      preserveQuestionUnderShellTitle: true
    })
    expect(out?.state).toBe('done')
  })

  // Repainting an idle interval begun before the hook does not establish a new boundary.
  it('keeps a fresh `working` hook after the idle interval began', () => {
    const hookAt = Date.now()
    const out = renewFromPtyTitle()(claudeStatus('working', hookAt), parkedOnPromptPty(hookAt), {
      preserveQuestionUnderShellTitle: true
    })
    expect(out?.state).toBe('working')
  })

  it('does not let replay delivery time outrank a newer title state transition', () => {
    const hookAt = Date.now() - 1_000
    const replayedAt = Date.now()
    const transitionPty = {
      ...parkedOnPromptPty(hookAt),
      lastAgentStatusRichInvalidatedAtEpochMs: hookAt + 1
    }
    const out = renewFromPtyTitle()(
      { ...claudeStatus('working', replayedAt), evidenceObservedAt: hookAt },
      transitionPty,
      { preserveQuestionUnderShellTitle: true }
    )

    expect(out?.state).toBe('done')
  })

  // Idle is absence of activity; working is positive resumed-turn evidence and can retire the question (#11761).
  it('still lets a working title retire a fresh `waiting`', () => {
    const hookAt = Date.now()
    const workingTitlePty = {
      ...parkedOnPromptPty(hookAt),
      lastAgentStatus: 'working',
      lastOscTitle: '⠋ Claude'
    }
    const out = renewFromPtyTitle()(claudeStatus('waiting', hookAt), workingTitlePty, {
      preserveQuestionUnderShellTitle: true
    })
    expect(out?.state).toBe('working')
  })
})
