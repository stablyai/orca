import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'

type WorktreeSetupReceipt = NonNullable<CreateWorktreeResult['setupReceipt']>

export function worktreeSetupReceipt(input: {
  requested: WorktreeSetupReceipt['requested']
  hookFound: boolean
  waitForAgentStartup: boolean | undefined
  shouldRunSetup: boolean
  setupStarted: boolean
  terminalHandle: string | null | undefined
}): WorktreeSetupReceipt {
  return {
    requested: input.requested,
    hookFound: input.hookFound,
    startupPolicy: input.waitForAgentStartup ? 'wait-for-setup' : 'start-immediately',
    state: !input.hookFound
      ? 'not_configured'
      : input.requested === 'skip' || !input.shouldRunSetup
        ? 'skipped'
        : // The in-process setup hook already started; spawn_failed would strand retrying callers.
          input.setupStarted
          ? 'running'
          : 'spawn_failed',
    ...(input.terminalHandle ? { terminalHandle: input.terminalHandle } : {})
  }
}
