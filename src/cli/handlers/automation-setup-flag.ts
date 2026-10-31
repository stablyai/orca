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

export function assertAutomationSetupMode(
  decision: 'run' | 'skip' | undefined,
  mode: AutomationWorkspaceMode | undefined
): void {
  if (decision !== undefined && mode === 'existing') {
    throw new RuntimeClientError(
      'invalid_argument',
      '--setup is only available for new-per-run automations.'
    )
  }
}
