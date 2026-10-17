import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from './persistence-test-harness'
import type { Store } from './persistence/loading-store/store'
import type { ProjectGroup } from '../shared/project-group-types'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      return decoded.replace(/^encrypted:/, '')
    }
  }
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => ({ hosts: [] })),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

function createChain(
  store: Store,
  levels: number,
  createdFrom: ProjectGroup['createdFrom']
): ProjectGroup[] {
  const groups: ProjectGroup[] = []
  for (let level = 1; level <= levels; level += 1) {
    groups.push(
      store.createProjectGroup({
        name: `Level ${level}`,
        parentGroupId: groups.at(-1)?.id ?? null,
        createdFrom
      })
    )
  }
  return groups
}

describe('project group nesting persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('creates a manual subgroup on its parent host', () => {
    const store = createStore()
    const parent = store.createProjectGroup({
      name: 'Remote',
      parentPath: '/srv/remote',
      connectionId: 'conn-1',
      createdFrom: 'folder-scan'
    })

    const child = store.createProjectGroup({
      name: 'Child',
      connectionId: null,
      parentGroupId: parent.id,
      createdFrom: 'manual'
    })

    expect(child).toMatchObject({ parentGroupId: parent.id, connectionId: 'conn-1' })
  })

  it('rejects a manual subgroup on a different host than its parent', () => {
    const store = createStore()
    const local = store.createProjectGroup({ name: 'Local', createdFrom: 'manual' })
    const remote = store.createProjectGroup({
      name: 'Remote',
      connectionId: 'conn-1',
      createdFrom: 'manual'
    })

    for (const [parent, connectionId] of [
      [remote, 'conn-2'],
      [local, 'conn-1']
    ] as const) {
      expect(() =>
        store.createProjectGroup({
          name: 'Child',
          connectionId,
          parentGroupId: parent.id,
          createdFrom: 'manual'
        })
      ).toThrow('same host')
    }
    expect(store.getProjectGroups()).toHaveLength(2)
    expect(
      store.createProjectGroup({
        name: 'Child',
        connectionId: 'conn-1',
        parentGroupId: remote.id,
        createdFrom: 'manual'
      }).connectionId
    ).toBe('conn-1')
  })

  it('rejects a manual subgroup under an empty or missing parent', () => {
    const store = createStore()

    for (const parentGroupId of ['', 'missing']) {
      expect(() =>
        store.createProjectGroup({ name: 'Child', parentGroupId, createdFrom: 'manual' })
      ).toThrow('Parent project group not found.')
    }
    expect(store.getProjectGroups()).toEqual([])
  })

  it('caps manual subgroups at three levels but keeps folder imports exempt', () => {
    const store = createStore()
    const [, , level3] = createChain(store, 3, 'manual')

    expect(() =>
      store.createProjectGroup({
        name: 'Too deep',
        parentGroupId: level3.id,
        createdFrom: 'manual'
      })
    ).toThrow('at most 3 levels')
    expect(
      store.createProjectGroup({
        name: 'Imported',
        parentGroupId: level3.id,
        createdFrom: 'folder-scan'
      }).parentGroupId
    ).toBe(level3.id)
  })

  it('moves a group last among its new siblings and back to the top level', () => {
    const store = createStore()
    const [a, b, c] = ['A', 'B', 'C'].map((name) =>
      store.createProjectGroup({ name, createdFrom: 'manual' })
    )

    expect(store.updateProjectGroup(c.id, { parentGroupId: a.id })).toMatchObject({
      parentGroupId: a.id,
      tabOrder: 3
    })
    expect(store.updateProjectGroup(b.id, { parentGroupId: a.id, tabOrder: 7 })).toMatchObject({
      parentGroupId: a.id,
      tabOrder: 7
    })
    expect(store.updateProjectGroup(c.id, { parentGroupId: null })?.parentGroupId).toBeNull()
  })

  it('rejects an invalid move without applying the rest of the update', () => {
    const store = createStore()
    const [root, child] = createChain(store, 2, 'manual')
    const before = structuredClone(store.getProjectGroups())

    expect(() =>
      store.updateProjectGroup(root.id, {
        parentGroupId: child.id,
        name: 'Renamed',
        isCollapsed: true,
        tabOrder: 9
      })
    ).toThrow('one of its subgroups')
    expect(store.getProjectGroups()).toEqual(before)
  })

  it('updates a group deeper than the cap when its parent is unchanged', () => {
    const store = createStore()
    const imported = createChain(store, 7, 'folder-scan')
    const { id, tabOrder } = imported[6]

    expect(
      store.updateProjectGroup(id, { name: 'Leaf', parentGroupId: imported[5].id })
    ).toMatchObject({ name: 'Leaf', parentGroupId: imported[5].id, tabOrder })
  })
})
