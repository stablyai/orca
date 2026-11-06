import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'

type WorktreeSetupReceipt = NonNullable<CreateWorktreeResult['setupReceipt']>

type WorktreeSetupReceiptInput = {
  requested: WorktreeSetupReceipt['requested']
  hookFound: boolean
  waitForAgentStartup: boolean | undefined
  shouldRunSetup: boolean
  setupStarted: boolean
  terminalHandle: string | null | undefined
}

export function worktreeSetupReceiptField(
  awaitedProvisioning: boolean | undefined,
  input: WorktreeSetupReceiptInput
): { setupReceipt?: WorktreeSetupReceipt } {
  return awaitedProvisioning ? { setupReceipt: worktreeSetupReceipt(input) } : {}
}

function worktreeSetupReceipt(input: WorktreeSetupReceiptInput): WorktreeSetupReceipt {
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
