import { RuntimeClientError } from '../runtime-client'
import type { AutomationWorkspaceMode } from '../../shared/automations-types'

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

// The cwd note applies only when create fell back to the current worktree.
export function assertAutomationSetupMode(
  decision: 'run' | 'skip' | undefined,
  mode: AutomationWorkspaceMode | undefined,
  createFlags?: Map<string, string | boolean>
): void {
  if (decision === undefined || mode !== 'existing') {
    return
  }
  const cwdDefault =
    createFlags && !createFlags.has('workspace') && !createFlags.has('workspace-mode')
  throw new RuntimeClientError(
    'invalid_argument',
    `--setup only applies to automations that create a new worktree per run, but this one runs in an existing worktree${cwdDefault ? ' (with no target, create uses the current worktree)' : ''}. Pass --workspace-mode new-per-run or omit --setup.`
  )
}
