import { ipcMain } from 'electron'
import { normalizeJiraQuickFilterState } from '../../shared/jira/jira-quick-filters'
import { JiraQuickFilterStateParam } from '../../shared/rpc-contract/jira/jira-quick-filter-params'
import {
  normalizeJiraSavedFilterState,
  mutateJiraSavedFilterState
} from '../../shared/jira/jira-saved-filters'
import { JiraSavedFilterMutationParam } from '../../shared/rpc-contract/jira/jira-saved-filter-params'
import type { Store } from '../persistence/loading-store/store'
import type { IpcHandleRegistrar } from './lazy-ipc-handle-group'

export function registerUiJiraFilterHandlers(
  store: Store,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle('ui:getJiraQuickFilters', () =>
    normalizeJiraQuickFilterState(store.getUI().jiraQuickFilterState)
  )
  ipc.handle('ui:setJiraQuickFilters', (_event, input: unknown) => {
    const state = normalizeJiraQuickFilterState(JiraQuickFilterStateParam.parse(input))
    store.updateUI({ jiraQuickFilterState: state })
    return state
  })
  ipc.handle('ui:getJiraSavedFilters', () =>
    normalizeJiraSavedFilterState(store.getUI().jiraSavedFilterState)
  )
  ipc.handle('ui:mutateJiraSavedFilters', (_event, input: unknown) => {
    const mutation = JiraSavedFilterMutationParam.parse(input)
    const state = mutateJiraSavedFilterState(store.getUI().jiraSavedFilterState, mutation)
    store.updateUI({ jiraSavedFilterState: state })
    return state
  })
}
