import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeTestStores, createStore, makeRepo, testState } from '../persistence-test-harness'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-project-default-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('persists a project default with independent setup creation', async () => {
  const initial = createStore()
  initial.addRepo({
    ...makeRepo({ id: 'r1', displayName: 'Cloud Project' }),
    upstream: { owner: 'stablyai', repo: 'cloud-project' }
  })
  await initial.flushPendingOrThrowAsync()
  await closeTestStores()

  const store = createStore()
  await store.flushPendingOrThrowAsync()
  store.createProjectHostSetup({
    projectId: 'github:stablyai/cloud-project',
    hostId: 'runtime:gpu-vm',
    defaultTuiAgent: 'codex'
  })
  await store.flushPendingOrThrowAsync()
  await closeTestStores()

  const reopened = createStore()
  expect(reopened.getProjects()).toContainEqual(
    expect.objectContaining({
      id: 'github:stablyai/cloud-project',
      defaultTuiAgent: 'codex'
    })
  )
  expect(reopened.getProjectHostSetups()).toContainEqual(
    expect.objectContaining({
      projectId: 'github:stablyai/cloud-project',
      hostId: 'runtime:gpu-vm'
    })
  )

  reopened.updateProject('github:stablyai/cloud-project', { defaultTuiAgent: 'blank' })
  await reopened.flushPendingOrThrowAsync()
  await closeTestStores()
  const blank = createStore()
  expect(blank.getProjects()).toContainEqual(
    expect.objectContaining({ id: 'github:stablyai/cloud-project', defaultTuiAgent: 'blank' })
  )

  blank.updateProject('github:stablyai/cloud-project', { defaultTuiAgent: null })
  await blank.flushPendingOrThrowAsync()
  await closeTestStores()
  expect(createStore().getProjects()).toContainEqual(
    expect.objectContaining({ id: 'github:stablyai/cloud-project', defaultTuiAgent: null })
  )
})
