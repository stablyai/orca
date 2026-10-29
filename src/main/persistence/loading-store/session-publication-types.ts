import type { SessionPaneAliasRecipe } from '../restoring-sessions/session-pane-alias-recipes'

import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ExecutionHostId } from '../../../shared/execution-host'

import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

import type { SessionUnitIndex } from '../../../shared/session-unit-index'

export type SessionRefSnapshot = Map<ExecutionHostId, Readonly<Record<string, number>>>

export type PublicationState = Pick<
  PersistedState,
  'workspaceSession' | 'workspaceSessionsByHostId'
> &
  Partial<Pick<PersistedState, 'legacyPaneKeyAliasEntries' | 'sshRemotePtyLeases' | 'repos'>>

export type Partition = {
  root: WorkspaceSessionState
  index: SessionUnitIndex
  generation: number
  versions: Map<string, number>
  refs: Readonly<Record<string, number>>
  aliases: Map<string, readonly SessionPaneAliasRecipe[]>
}
