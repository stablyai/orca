import { RuntimeClientError } from '../runtime-client'
import type { Automation, AutomationWorkspaceMode } from '../../shared/automations-types'

export function getAutomationSetupFlag(
  flags: Map<string, string | boolean>
): 'run' | 'skip' | undefined {
  if (!flags.has('setup')) {
    return undefined
  }
  const value = flags.get('setup')
  if (value === 'run' || value === 'skip') {
    return value
  }
  throw new RuntimeClientError('invalid_argument', '--setup must be run or skip.')
}

const SETUP_REMEDY = {
  create:
    ' (with no target, create uses the current worktree). Pass --repo <selector> or --workspace-mode new-per-run, or omit --setup.',
  edit: '. Pass --workspace-mode new-per-run to switch it, or omit --setup.'
}

export function assertAutomationSetupMode(
  decision: 'run' | 'skip' | undefined,
  mode: AutomationWorkspaceMode | undefined,
  command: keyof typeof SETUP_REMEDY
): void {
  if (decision !== undefined && mode === 'existing') {
    throw new RuntimeClientError(
      'invalid_argument',
      `--setup only applies to automations that create a new worktree per run, but this one runs in an existing worktree${SETUP_REMEDY[command]}`
    )
  }
}

// Hosts before v1.4.105 strip setupDecision without an error, so read the saved record back.
export function checkAutomationSetupSaved<T extends { result: { automation: Automation } }>(
  response: T,
  decision: 'run' | 'skip' | undefined
): T {
  const { automation } = response.result
  if (decision === undefined || automation.setupDecision === decision) {
    return response
  }
  throw new RuntimeClientError(
    'incompatible_runtime',
    `The host saved automation ${automation.id} but did not keep --setup ${decision}, so its runs will use setup ${automation.setupDecision ?? 'skip'}. Update Orca on that host, then run orca automations edit ${automation.id} --setup ${decision}.`
  )
}
