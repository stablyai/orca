import { describe, expect, it } from 'vitest'
import { readAgentLaunchCreateOutcome } from './agent-launch-request'

const FALLBACK_DETAIL =
  "Your default is a structured chat session, but its chat runtime isn't installed on this host (install it from a new chat tab in Orca); started a terminal agent instead."

function launchReply(receipt: Record<string, string>, warning?: string) {
  return {
    outcome: { kind: 'terminal', handle: 'term_1' },
    worktreeId: 'repo::/w',
    receipt,
    ...(warning ? { warning } : {})
  }
}

describe('readAgentLaunchCreateOutcome', () => {
  it('surfaces why a chat default started a terminal', () => {
    const reply = launchReply({
      mode: 'terminal',
      preferred: 'structured',
      reason: 'chat_runtime_not_installed',
      detail: FALLBACK_DETAIL
    })
    expect(readAgentLaunchCreateOutcome(reply)).toEqual({
      worktreeId: 'repo::/w',
      warning: FALLBACK_DETAIL
    })
  })

  it('stays quiet when a terminal was the chosen default', () => {
    const reply = launchReply({
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'user_default',
      detail: 'Started a terminal agent, the default for new agent tabs in your settings.'
    })
    expect(readAgentLaunchCreateOutcome(reply)).toEqual({ worktreeId: 'repo::/w' })
  })
})
