import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, testState, createStore, makeRepo } from './persistence-test-harness'
vi.mock('electron', () => ({ app: { getPath: () => testState.dir } }))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({ nth_repo_added: 2 }) }))
const project = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
describe('persisted repository Jira defaults', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-jira-project-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })
  it('persists and clears the project default across restart without requiring Git', () => {
    const store = createStore()
    store.addRepo(makeRepo({ kind: 'folder' }))
    expect(store.updateRepo('r1', { defaultJiraProject: project })?.defaultJiraProject).toEqual(
      project
    )
    store.flush()
    const reloaded = createStore()
    expect(reloaded.getRepo('r1')?.defaultJiraProject).toEqual(project)
    reloaded.updateRepo('r1', { defaultJiraProject: null })
    reloaded.flush()
    expect(createStore().getRepo('r1')?.defaultJiraProject).toBeNull()
  })
})
