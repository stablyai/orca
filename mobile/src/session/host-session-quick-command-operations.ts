import type {
  TerminalQuickCommand,
  TerminalQuickCommandScope
} from '../../../src/shared/terminal-quick-command-types'
import type { TerminalQuickCommandMutation } from '../terminal/quick-commands'

export type HostSessionQuickCommandSnapshot = {
  commands: TerminalQuickCommand[]
  totalCount: number
  repoId: string | null
}

export type HostSessionQuickCommandOperations = {
  snapshot(workspaceId: string, signal?: AbortSignal): Promise<HostSessionQuickCommandSnapshot>
  mutate(
    workspaceId: string,
    mutation: TerminalQuickCommandMutation
  ): Promise<HostSessionQuickCommandSnapshot>
}

export function explicitQuickCommandScope(
  scope: TerminalQuickCommandScope | undefined
): TerminalQuickCommandScope {
  return scope?.type === 'repo' ? { type: 'repo', repoId: scope.repoId } : { type: 'global' }
}
