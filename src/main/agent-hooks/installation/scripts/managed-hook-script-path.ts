import { orcaHomeDir } from '../../../../shared/app-profiles/app-profile-homes'
import { join } from 'node:path'

// Parallel Orca instances must share one user-wide script path.
export function getSharedManagedScriptPath(scriptFileName: string): string {
  return join(orcaHomeDir(), 'agent-hooks', scriptFileName)
}
