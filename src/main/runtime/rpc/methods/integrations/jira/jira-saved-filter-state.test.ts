import '../../../server/runtime-rpc-mobile-method-routing'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../../../shared/orca-profiles/constants'
import type { PersistedUIState } from '../../../../../../shared/orca-profiles/persisted-ui-state-types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { CLIENT_UI_METHODS } from '../../client-state/client-ui'
import { RpcDispatcher } from '../../../dispatcher'

const filter = { id: 'mine', name: 'My work', jql: 'assignee = currentUser()' }
function setup() {
  let ui: PersistedUIState = {
    ...getDefaultUIState(),
    taskResumeState: { jiraQuery: 'project = OLD' }
  }
  const updateUIState = vi.fn((updates: Partial<PersistedUIState>) => {
    ui = { ...ui, ...updates }
    return ui
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The dispatcher only invokes these three runtime methods in this test.
  const runtime = {
    getRuntimeId: () => 'host-a',
    getUIState: () => ui,
    updateUIState
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
  const dispatch = (method: string, params?: unknown) =>
    dispatcher.dispatch({ id: 'request', method, params, authToken: 'token' })
  return { dispatch, updateUIState, read: () => ui }
}
describe('Jira saved-filter runtime UI state', () => {
  it('stores filters on the called host while preserving the old strict taskResumeState shape', async () => {
    const { dispatch, read, updateUIState } = setup()
    expect(await dispatch('ui.getJiraSavedFilters')).toMatchObject({
      ok: true,
      result: { filters: [], activeFilterId: null }
    })
    expect(await dispatch('ui.mutateJiraSavedFilters', { kind: 'save', filter })).toMatchObject({
      ok: true,
      result: { filters: [filter] }
    })
    expect(
      await dispatch('ui.mutateJiraSavedFilters', { kind: 'select', id: filter.id })
    ).toMatchObject({ ok: true, result: { activeFilterId: filter.id } })
    expect(read().taskResumeState).toEqual({ jiraQuery: 'project = OLD' })
    expect(updateUIState.mock.calls.every(([update]) => !('taskResumeState' in update))).toBe(true)
    expect(await dispatch('ui.getJiraSavedFilters')).toMatchObject({
      ok: true,
      result: { filters: [filter], activeFilterId: filter.id }
    })
  })
  it('applies mutations to current host state so two clients do not erase each other’s filters', async () => {
    const { dispatch } = setup()
    const second = { id: 'bugs', name: 'Bugs', jql: 'type = Bug' }
    await dispatch('ui.mutateJiraSavedFilters', { kind: 'save', filter })
    await dispatch('ui.mutateJiraSavedFilters', { kind: 'save', filter: second })
    expect(await dispatch('ui.getJiraSavedFilters')).toMatchObject({
      ok: true,
      result: { filters: [filter, second] }
    })
    await dispatch('ui.mutateJiraSavedFilters', { kind: 'delete', id: filter.id })
    expect(await dispatch('ui.getJiraSavedFilters')).toMatchObject({
      ok: true,
      result: { filters: [second] }
    })
  })
})
