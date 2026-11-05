// Removed SSH targets cannot recover through retry; users must re-add the host or delete the automation.

import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  isAutomationOwnerConflictCode
} from '../shared/automation-owner-conflict'

export type AutomationOwnerConflictRecovery = { nextSteps: readonly string[] }

const RECOVERY: Record<string, readonly string[]> = {
  [AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged]: [
    'The automation moved to a different host between the read and the write.',
    'Run the command again; it captures the current host on each attempt.'
  ],
  [AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved]: [
    'This automation is pinned to an SSH host that is no longer registered, so it cannot run and retrying will not change that.',
    'Re-add that SSH host, or delete the automation with `orca automations remove --id <id>`.'
  ],
  [AUTOMATION_OWNER_CONFLICT_CODES.fencingRequired]: [
    'The host accepted the request but did not report which host owns the automation, so the CLI had no owner to send.',
    'Update Orca on the host, then run the command again.'
  ],
  [AUTOMATION_OWNER_CONFLICT_CODES.invalidDestination]: [
    'The host this command targets is not registered on the authority that stores the automation.',
    'Run `orca automations show --id <id>` to see where it lives, then target a host that authority knows.'
  ]
}

export function automationOwnerConflictRecovery(
  code: string | null | undefined
): AutomationOwnerConflictRecovery | undefined {
  return isAutomationOwnerConflictCode(code) ? { nextSteps: RECOVERY[code] } : undefined
}
