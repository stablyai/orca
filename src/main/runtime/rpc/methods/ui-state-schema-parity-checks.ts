import type { z } from 'zod'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { WorkspaceCleanupUIState } from '../../../../shared/workspace-cleanup'
import type { UiUpdateFieldsSchema } from './client-ui-schemas'
import type { AssertNoMissingKeys, AssertNoMissingValues } from './ui-state-schema-parity'

// Main-only UI fields never arrive from clients; parity checks enforce their deliberate omission from the strict schema.
type MainOwnedUIState =
  | 'personalProjectOrder'
  | 'jiraSavedFilterState'
  | 'jiraQuickFilterState'
  | '_explorerDisplayRootMigrated'
  | 'trayMinimizeNoticeShown'
  | 'dashboardPopoutBounds'
  | '_expandedWorktreeCardPropertiesDefaulted'
  | '_jiraIssueWorktreeCardPropertyDefaulted'
  | '_hostWorktreeCardPropertyDefaulted'
  | 'starNagBaselineAgents'
  | 'starNagAppVersion'
  | 'starNagNextThreshold'
  | 'starNagCompleted'
  | 'starNagDeferredUntil'
  | 'starNagAgentValueMomentAppVersion'
  // Desktop-local replay queue: a paired client must not overwrite it.
  | 'pendingRuntimeRepoRemovals'
const _uiUpdateParity: AssertNoMissingKeys<
  Omit<PersistedUIState, MainOwnedUIState>,
  z.infer<UiUpdateFieldsSchema>
> = true
void _uiUpdateParity

// Check every shared key's z.input domain: key parity alone missed enum values, and transforms narrow z.infer.
const _uiUpdateValueParity: AssertNoMissingValues<
  Omit<PersistedUIState, MainOwnedUIState>,
  z.input<UiUpdateFieldsSchema>
> = true
void _uiUpdateValueParity

// Check nested keys too: structural extends permits extras that strict workspaceCleanup would reject, including newer filter groups.
type WorkspaceCleanupSchema = NonNullable<z.input<UiUpdateFieldsSchema>['workspaceCleanup']>
const _workspaceCleanupParity: AssertNoMissingKeys<
  WorkspaceCleanupUIState,
  WorkspaceCleanupSchema
> = true
void _workspaceCleanupParity
const _workspaceCleanupValueParity: AssertNoMissingValues<
  WorkspaceCleanupUIState,
  WorkspaceCleanupSchema
> = true
void _workspaceCleanupValueParity
