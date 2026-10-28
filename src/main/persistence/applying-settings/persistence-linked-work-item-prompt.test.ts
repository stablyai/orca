import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, testState, createStore, makeRepo } from '../persistence-test-harness'

vi.mock('electron', () => ({ app: { getPath: () => testState.dir } }))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

describe('linked work item prompt settings', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-task-prompt-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('persists global and folder-project templates, clears overrides, and preserves them through repo refresh', () => {
    const store = createStore()
    store.addRepo(makeRepo({ kind: 'folder' }))
    const projectId = store.getProjects()[0]!.id
    store.updateSettings({ linkedWorkItemPromptTemplate: '{url} /global' })
    store.updateProject(projectId, { linkedWorkItemPromptTemplate: '{url} /project' })
    store.updateRepo({ id: 'r1' }, { displayName: 'Renamed' })
    store.flush()
    const reloaded = createStore()
    expect(reloaded.getSettings().linkedWorkItemPromptTemplate).toBe('{url} /global')
    expect(reloaded.getProjects()[0]?.linkedWorkItemPromptTemplate).toBe('{url} /project')
    reloaded.updateProject(projectId, { linkedWorkItemPromptTemplate: null })
    reloaded.flush()
    expect(createStore().getProjects()[0]?.linkedWorkItemPromptTemplate).toBeUndefined()
    reloaded.updateProject(projectId, { linkedWorkItemPromptTemplate: '  ' })
    reloaded.updateSettings({ linkedWorkItemPromptTemplate: '' })
    reloaded.flush()
    expect(createStore().getSettings().linkedWorkItemPromptTemplate).toBeUndefined()
  })

  it('ignores invalid update types and removes invalid persisted values at load', () => {
    const store = createStore()
    store.addRepo(makeRepo())
    const projectId = store.getProjects()[0]!.id
    store.updateSettings({ linkedWorkItemPromptTemplate: '{url} /global' })
    store.updateProject(projectId, { linkedWorkItemPromptTemplate: '{url} /project' })
    const invalid = { linkedWorkItemPromptTemplate: '{url}' }
    Reflect.set(invalid, 'linkedWorkItemPromptTemplate', 23)
    store.updateSettings(invalid)
    store.updateProject(projectId, invalid)
    expect(store.getSettings().linkedWorkItemPromptTemplate).toBe('{url} /global')
    expect(store.getProjects()[0]?.linkedWorkItemPromptTemplate).toBe('{url} /project')
    Reflect.set(store.getSettings(), 'linkedWorkItemPromptTemplate', 23)
    Reflect.set(store.getProjects()[0]!, 'linkedWorkItemPromptTemplate', 23)
    store.flush()
    const reloaded = createStore()
    expect(reloaded.getSettings().linkedWorkItemPromptTemplate).toBeUndefined()
    expect(reloaded.getProjects()[0]?.linkedWorkItemPromptTemplate).toBeUndefined()
  })
})
