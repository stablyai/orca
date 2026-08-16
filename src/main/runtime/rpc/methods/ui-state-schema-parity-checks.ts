import type { z } from 'zod'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { WorkspaceCleanupUIState } from '../../../../shared/workspace-cleanup'
import type { UiUpdateFieldsSchema } from './client-ui-schemas'
import type { AssertNoMissingKeys, AssertNoMissingValues } from './ui-state-schema-parity'

// Why: state only the main process ever writes (store.updateUI, star-nag's own
// IPC, window lifecycle). Clients never send these, so keeping them out of the
// strict schema is deliberate — but it must stay deliberate rather than
// forgotten, which is what the parity assertion below enforces.
type MainOwnedUIState =
  | 'trayMinimizeNoticeShown'
  | 'dashboardPopoutBounds'
  | '_expandedWorktreeCardPropertiesDefaulted'
  | '_jiraIssueWorktreeCardPropertyDefaulted'
  | 'starNagBaselineAgents'
  | 'starNagAppVersion'
  | 'starNagNextThreshold'
  | 'starNagCompleted'
  | 'starNagDeferredUntil'
  | 'starNagAgentValueMomentAppVersion'
const _uiUpdateParity: AssertNoMissingKeys<
  Omit<PersistedUIState, MainOwnedUIState>,
  z.infer<UiUpdateFieldsSchema>
> = true
void _uiUpdateParity

// Why: key parity is blind to enum drift, which is how 'cli' and three
// rightSidebarTab members went missing while the guard above stayed green.
// Checked over every shared key, not a hand-picked pair — naming the two known
// offenders would leave the next field to drift exactly as unguarded.
// z.input, not z.infer: what a client may SEND, before `.transform()` narrows it.
const _uiUpdateValueParity: AssertNoMissingValues<
  Omit<PersistedUIState, MainOwnedUIState>,
  z.input<UiUpdateFieldsSchema>
> = true
void _uiUpdateValueParity

// Why a nested pair: the guards above only walk PersistedUIState's OWN keys, and
// a structural `extends` is satisfied by extra properties — so a sub-key added
// to workspaceCleanup (e.g. `browse`) and never added to its `.strict()` schema
// would keep both green while every paired client's ui.set payload is rejected.
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
