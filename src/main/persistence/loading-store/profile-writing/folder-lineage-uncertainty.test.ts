import { mkdirSync } from 'node:fs'
import * as lineageUncertainty from '../../../../shared/worktree/lineage/lineage-uncertainty'
import { checkWorkspacePullRequests } from '../../../../shared/orchestration/workspace-pr-check'
import { describe, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { createWorkerBackedStore, writerBarrier } from './folder-lineage-uncertainty-fixture'
import { makeRepo } from '../../persistence-test-harness'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { worktreeWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

async function seed() {
  const h = await createWorkerBackedStore()
  h.store.addRepo(makeRepo({ id: 'q', path: h.directory, executionHostId: 'local' }))
  const child = `q::${h.directory}/child`
  mkdirSync(`${h.directory}/child`, { recursive: true })
  const target = hostWorktreeTarget({ id: child, hostId: 'local' })
  h.store.setWorktreeMeta(target, { instanceId: 'child-instance', createdAt: 1 })
  const group = h.store.createProjectGroup({
    name: 'Parent',
    parentPath: h.directory,
    createdFrom: 'manual'
  })
  const folder = h.store.createFolderWorkspace({ projectGroupId: group.id })
  h.store.setFolderParentLineage(target, {
    childWorkspaceKey: worktreeWorkspaceKey(child),
    childInstanceId: 'child-instance',
    parentWorkspaceKey: `folder:${folder.id}`,
    parentInstanceId: 'unverifiable',
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1
  })
  await h.store.flushPendingOrThrowAsync()
  return {
    ...h,
    folder,
    key: worktreeWorkspaceKey(child),
    marker: JSON.stringify(['local', worktreeWorkspaceKey(child)])
  }
}

describe('folder erasure through the actual async profile writer', () => {
  it('carries uncertainty in the same durable snapshot after an older write is queued', async () => {
    const h = await seed()
    const entered = writerBarrier(),
      release = writerBarrier()
    const original = h.authority.writeSerializedDomains.bind(h.authority)
    vi.spyOn(h.authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      entered.resolve()
      await release.promise
      await original(domains)
    })
    h.store.updateFolderWorkspace(h.folder.id, { name: 'Renamed' })
    const oldWrite = h.store.flushPendingOrThrowAsync()
    await entered.promise
    h.store.removeFolderWorkspace(h.folder.id)
    expect(h.readState().workspaceLineageByChildKey[h.key]).toMatchObject({
      parentInstanceId: 'unverifiable'
    })
    release.resolve()
    await oldWrite
    await h.store.flushPendingOrThrowAsync()
    const saved = h.readState()
    expect(saved.workspaceLineageByChildKey[h.key]).toBeUndefined()
    expect(saved.workspaceLineageUncertaintyByChild[h.marker]).toBe(true)
  })

  it('rolls back edge erasure when inserting the uncertainty domain fails inside SQLite', async () => {
    const h = await seed()
    const fault = new Database(h.databaseFile)
    fault.exec(
      `CREATE TRIGGER reject_lineage_uncertainty_insert BEFORE INSERT ON profile_state_documents WHEN NEW.domain = 'workspaceLineageUncertaintyByChild' BEGIN SELECT RAISE(ABORT, 'uncertainty write failure'); END`
    )
    fault.exec(
      `CREATE TRIGGER reject_lineage_uncertainty_update BEFORE UPDATE ON profile_state_documents WHEN NEW.domain = 'workspaceLineageUncertaintyByChild' BEGIN SELECT RAISE(ABORT, 'uncertainty write failure'); END`
    )
    try {
      h.store.removeFolderWorkspace(h.folder.id)
      await expect(h.store.flushPendingOrThrowAsync()).rejects.toThrow()
      const saved = h.readState()
      expect(saved.workspaceLineageByChildKey[h.key]).toMatchObject({
        parentInstanceId: 'unverifiable'
      })
      expect(saved.folderWorkspaces).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: h.folder.id })])
      )
      expect(h.store.getWorkspaceLineageUncertainty()[h.marker]).toBe(true)
    } finally {
      fault.exec('DROP TRIGGER reject_lineage_uncertainty_insert')
      fault.exec('DROP TRIGGER reject_lineage_uncertainty_update')
      fault.close()
    }
  })

  it('retains the committed marker when acknowledgement is lost after commit', async () => {
    const h = await seed()
    const original = h.authority.writeSerializedDomains.bind(h.authority)
    vi.spyOn(h.authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      await original(domains)
      throw new Error('lost acknowledgement')
    })
    h.store.removeFolderWorkspace(h.folder.id)
    await expect(h.store.flushPendingOrThrowAsync()).rejects.toThrow()
    const saved = h.readState()
    expect(saved.workspaceLineageByChildKey[h.key]).toBeUndefined()
    expect(saved.workspaceLineageUncertaintyByChild[h.marker]).toBe(true)
  })
  it('keeps the old unresolved edge durable when capture fails before erasure', async () => {
    const h = await seed()
    vi.spyOn(lineageUncertainty, 'preserveFolderLineageUncertainty').mockImplementationOnce(() => {
      throw new Error('capture interrupted')
    })
    expect(() => h.store.removeFolderWorkspace(h.folder.id)).toThrow('capture interrupted')
    await h.store.flushPendingOrThrowAsync()
    expect(h.readState().workspaceLineageByChildKey[h.key]).toMatchObject({
      parentInstanceId: 'unverifiable'
    })
  })

  it('persists host-qualified and unknown-host markers without confusing same-id children', async () => {
    const h = await seed()
    h.store.removeFolderWorkspace(h.folder.id)
    expect(h.store.removeFolderWorkspace(h.folder.id)).toBe(false)
    await h.store.flushPendingOrThrowAsync()
    const saved = h.readState()
    const local = makeRepo({
      id: 'q',
      path: h.directory,
      executionHostId: 'local',
      gitRemoteIdentity: { canonicalKey: 'github.com/org/q', remoteName: 'origin', remoteUrl: '' }
    })
    const remote = { ...local, executionHostId: 'ssh:remote' as const }
    const input = {
      repos: [local, remote],
      metadata: () => undefined,
      lineage: {},
      workspaceLineage: {},
      crossStoreLineage: {},
      folders: [],
      primaries: [],
      uncertainty: saved.workspaceLineageUncertaintyByChild
    }
    expect(
      checkWorkspacePullRequests(input, {
        subject: 'https://github.com/org/q/pull/17',
        body: '',
        spec: '',
        host: 'local'
      })
    ).toEqual({ version: 1, state: 'partial', outside: [] })
    expect(
      checkWorkspacePullRequests(input, {
        subject: 'https://github.com/org/q/pull/17',
        body: '',
        spec: '',
        host: 'ssh:remote'
      })
    ).toEqual({
      version: 1,
      state: 'complete',
      outside: [{ forgeHost: 'github.com', owner: 'org', repo: 'q', number: 17 }]
    })
    h.store.addRepo(makeRepo({ id: 'q', path: h.directory, executionHostId: 'ssh:remote' }))
    const group = h.store.createProjectGroup({
      name: 'Another',
      parentPath: h.directory,
      createdFrom: 'manual'
    })
    const folder = h.store.createFolderWorkspace({ projectGroupId: group.id })
    const child = h.key.slice('worktree:'.length)
    h.store.setFolderParentLineage(hostWorktreeTarget({ id: child, hostId: 'local' }), {
      childWorkspaceKey: h.key,
      childInstanceId: 'child-instance',
      parentWorkspaceKey: `folder:${folder.id}`,
      parentInstanceId: 'unverifiable',
      origin: 'cli',
      capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
      createdAt: 1
    })
    h.store.removeFolderWorkspace(folder.id)
    await h.store.flushPendingOrThrowAsync()
    expect(h.readState().workspaceLineageUncertaintyByChild[JSON.stringify([null, h.key])]).toBe(
      true
    )
    input.uncertainty = h.readState().workspaceLineageUncertaintyByChild
    expect(
      checkWorkspacePullRequests(input, {
        subject: 'https://github.com/org/q/pull/17',
        body: '',
        spec: '',
        host: 'ssh:remote'
      })
    ).toEqual({ version: 1, state: 'partial', outside: [] })
  })
})
