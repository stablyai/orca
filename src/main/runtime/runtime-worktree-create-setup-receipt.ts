import type { CreateWorktreeResult } from '../../shared/worktree/create-types'

export function worktreeCreateSetupReceipt(args: {
  effectiveDecision: NonNullable<CreateWorktreeResult['setupReceipt']>['requested']
  hookFound: boolean
  shouldRunSetup: boolean
  waitForAgentStartup?: boolean
  started: boolean
  setupTerminalHandle: string | null
}): NonNullable<CreateWorktreeResult['setupReceipt']> {
  return {
    requested: args.effectiveDecision,
    hookFound: args.hookFound,
    startupPolicy: args.waitForAgentStartup ? 'wait-for-setup' : 'start-immediately',
    state: !args.hookFound
      ? 'not_configured'
      : args.effectiveDecision === 'skip' || !args.shouldRunSetup
        ? 'skipped'
        : args.started
          ? 'running'
          : 'spawn_failed',
    ...(args.setupTerminalHandle ? { terminalHandle: args.setupTerminalHandle } : {})
  }
}
