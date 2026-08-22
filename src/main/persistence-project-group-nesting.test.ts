import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAX_PROJECT_GROUP_DEPTH } from '../shared/project-group-reparent'
import { testState, createStore } from './persistence-test-harness'

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => false
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

describe('Store project group nesting', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('re-parents a group and appends it after its new siblings', async () => {
    const store = await createStore()
    const perc = store.createProjectGroup({ name: 'Perc', createdFrom: 'manual' })
    const backend = store.createProjectGroup({ name: 'Backend', createdFrom: 'manual' })
    const tools = store.createProjectGroup({
      name: 'Tools',
      parentGroupId: perc.id,
      createdFrom: 'manual'
    })

    const moved = store.updateProjectGroup(backend.id, { parentGroupId: perc.id })

    expect(moved?.parentGroupId).toBe(perc.id)
    expect(moved!.tabOrder).toBeGreaterThan(tools.tabOrder)
    expect(store.updateProjectGroup(backend.id, { parentGroupId: null })?.parentGroupId).toBeNull()
  })

  it('keeps tabOrder when the parent does not change or is given explicitly', async () => {
    const store = await createStore()
    const perc = store.createProjectGroup({ name: 'Perc', createdFrom: 'manual' })
    const child = store.createProjectGroup({
      name: 'Child',
      parentGroupId: perc.id,
      createdFrom: 'manual'
    })
    store.createProjectGroup({ name: 'Later', createdFrom: 'manual' })

    expect(store.updateProjectGroup(child.id, { parentGroupId: perc.id })?.tabOrder).toBe(
      child.tabOrder
    )
    expect(store.updateProjectGroup(child.id, { parentGroupId: null, tabOrder: 0 })?.tabOrder).toBe(
      0
    )
  })

  it('rejects moving a group into itself or into a descendant', async () => {
    const store = await createStore()
    const root = store.createProjectGroup({ name: 'Root', createdFrom: 'manual' })
    const child = store.createProjectGroup({
      name: 'Child',
      parentGroupId: root.id,
      createdFrom: 'manual'
    })
    const grandchild = store.createProjectGroup({
      name: 'Grandchild',
      parentGroupId: child.id,
      createdFrom: 'manual'
    })

    expect(() => store.updateProjectGroup(root.id, { parentGroupId: root.id })).toThrow(
      /into itself/
    )
    expect(() => store.updateProjectGroup(root.id, { parentGroupId: grandchild.id })).toThrow(
      /own subgroups/
    )
    expect(() => store.updateProjectGroup(root.id, { parentGroupId: 'missing' })).toThrow(
      /Parent project group not found/
    )
    expect(store.getProjectGroups().find((group) => group.id === root.id)?.parentGroupId).toBeNull()
  })

  it('rejects manual nesting beyond MAX_PROJECT_GROUP_DEPTH but not folder-scan imports', async () => {
    const store = await createStore()
    let parentId: string | null = null
    for (let depth = 0; depth <= MAX_PROJECT_GROUP_DEPTH; depth += 1) {
      parentId = store.createProjectGroup({
        name: `Level ${depth}`,
        parentGroupId: parentId,
        createdFrom: 'manual'
      }).id
    }
    const deepest = parentId!

    expect(() =>
      store.createProjectGroup({ name: 'Too deep', parentGroupId: deepest, createdFrom: 'manual' })
    ).toThrow(new RegExp(`${MAX_PROJECT_GROUP_DEPTH} levels`))
    expect(() =>
      store.createProjectGroup({
        name: 'Missing parent',
        parentGroupId: 'nope',
        createdFrom: 'manual'
      })
    ).toThrow(/Parent project group not found/)

    const lone = store.createProjectGroup({ name: 'Lone', createdFrom: 'manual' })
    expect(() => store.updateProjectGroup(lone.id, { parentGroupId: deepest })).toThrow(/levels/)

    const scanned = store.createProjectGroup({
      name: 'Scanned',
      parentPath: '/srv/deep',
      parentGroupId: deepest,
      createdFrom: 'folder-scan'
    })
    expect(scanned.parentGroupId).toBe(deepest)
  })
})
