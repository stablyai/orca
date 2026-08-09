import type { z } from 'zod'
import type { PersistedUIState } from '../../../../shared/types'
import type { UiUpdateFieldsSchema } from './client-ui-schemas'
import type { AssertNoMissingKeys, AssertNoMissingValues } from './ui-state-schema-parity'

// Exclude main-owned and desktop-only state while guarding every runtime-writable field.
type NonRuntimeClientUIState =
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
  | 'activeSpaceId'
  | 'lastWorkspaceKeyBySpaceId'
const _uiUpdateParity: AssertNoMissingKeys<
  Omit<PersistedUIState, NonRuntimeClientUIState>,
  z.infer<UiUpdateFieldsSchema>
> = true
void _uiUpdateParity

// Why: key parity is blind to enum drift, which is how 'cli' and three
// rightSidebarTab members went missing while the guard above stayed green.
// Checked over every shared key, not a hand-picked pair — naming the two known
// offenders would leave the next field to drift exactly as unguarded.
// z.input, not z.infer: what a client may SEND, before `.transform()` narrows it.
const _uiUpdateValueParity: AssertNoMissingValues<
  Omit<PersistedUIState, NonRuntimeClientUIState>,
  z.input<UiUpdateFieldsSchema>
> = true
void _uiUpdateValueParity
