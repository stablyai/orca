import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { AGENT_STATUS_STALE_AFTER_MS, type AgentStatusEntry } from '../../shared/agent-status-types'

// Timings below are the measured deltas from a real `claude` 2.1.234 parked on a
// Write permission prompt (epoch ms, one capture of two with identical structure):
//   ...900370  PreToolUse Write
//   ...900382  title "◐ Claude Code" → "✳ Claude Code"    settle, working→idle
//   ...900421  PermissionRequest Write                     the hook Orca reports as `waiting`
//   ...900544  title → "✳ probe2.txt Write tool file"      same idle class, last write
//   then 31s of silence with the prompt still up.
// The trailing same-class repaint is the whole defect: it advances lastOscTitleEpochMs
// past a hook that is still current, while lastAgentStatusRichInvalidatedAtEpochMs (which
// moves only on a class change) stays at the settle.
const SETTLE_AFTER_HOOK_MS = -39
const TRAILING_TITLE_AFTER_HOOK_MS = 123

// Private by design — the projection has no public entry point, and testing it through a
// full session.tabs publication would bury the one decision this suite is about.
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

/** The PTY as it stands once Claude has raised the prompt and gone quiet. */
function parkedOnPromptPty(hookAt: number): unknown {
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
  // Why both names: Claude's PermissionRequest normalizes to `waiting`, not `blocked`
  // (agent-hook-listener normalizeClaudeEvent), so a guard written against `blocked`
  // alone passes its own tests and still misses every Claude permission prompt.
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

  // Why: the guard is bounded by freshness, or an agent killed while parked on a prompt
  // would hold the card open forever instead of decaying like any other abandoned row.
  it('still lets the title retire a `waiting` older than the stale boundary', () => {
    const hookAt = Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1
    const out = renewFromPtyTitle()(claudeStatus('waiting', hookAt), parkedOnPromptPty(hookAt), {
      preserveQuestionUnderShellTitle: true
    })
    expect(out?.state).toBe('done')
  })

  // Why: proves the guard is scoped to pending-answer states rather than switching off
  // title renewal wholesale — an idle title must still retire a stale spinner (#1437).
  it('still lets an idle title retire a fresh `working`', () => {
    const hookAt = Date.now()
    const out = renewFromPtyTitle()(claudeStatus('working', hookAt), parkedOnPromptPty(hookAt), {
      preserveQuestionUnderShellTitle: true
    })
    expect(out?.state).toBe('done')
  })

  // Why: an idle title is the ABSENCE of activity evidence, so it cannot outrank the hook.
  // A `working` title is positive evidence the agent resumed, which does — otherwise a
  // finished turn's question card would linger into the next working interval (#11761).
  it('still lets a working title retire a fresh `waiting`', () => {
    const hookAt = Date.now()
    const workingTitlePty = {
      ...(parkedOnPromptPty(hookAt) as Record<string, unknown>),
      lastAgentStatus: 'working',
      lastOscTitle: '⠋ Claude'
    }
    const out = renewFromPtyTitle()(claudeStatus('waiting', hookAt), workingTitlePty, {
      preserveQuestionUnderShellTitle: true
    })
    expect(out?.state).toBe('working')
  })
})
