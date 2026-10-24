import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeTestStores, createStore, testState } from '../../persistence-test-harness'
import { normalizeJiraSavedFilterState } from '../../../shared/jira/jira-saved-filters'
vi.mock('electron', () => ({ app: { getPath: () => testState.dir } }))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-jira-saved-filters-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})
it('persists multiple saved filters and the active selection across a profile reload', async () => {
  const state = {
    filters: [
      { id: 'mine', name: 'My work', jql: 'assignee = currentUser()' },
      { id: 'bugs', name: 'Bugs', jql: 'project = APP AND type = Bug' }
    ],
    activeFilterId: 'bugs'
  }
  const store = createStore()
  store.updateUI({
    jiraSavedFilterState: state,
    jiraQuickFilterState: { statuses: ['In Progress', 'Blocked'] }
  })
  store.flush()
  await closeTestStores()
  const reloaded = createStore()
  expect(normalizeJiraSavedFilterState(reloaded.getUI().jiraSavedFilterState)).toEqual(state)
  expect(reloaded.getUI().jiraQuickFilterState).toEqual({ statuses: ['In Progress', 'Blocked'] })
})
