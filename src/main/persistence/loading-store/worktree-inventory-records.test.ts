import { describe, expect, it } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { collectWorktreeInventoryRecords } from './worktree-inventory-records'

function state() {
  return {
    worktreeMeta: {},
    worktreeMetaByIdentity: {},
    worktreeIdentityAliases: {},
    worktreeLineageById: {},
    workspaceLineageByChildKey: {}
  } as unknown as PersistedState
}

describe('read-only inventory registration snapshot', () => {
  it('preserves competing identities, every alias and canonical-only metadata', () => {
    const data = state()
    data.worktreeIdentityAliases = {
      'local|repo::/gone': ['wt2:local:a', 'wt2:local:b'],
      'local|repo::/old-name': ['wt2:local:a']
    }
    data.worktreeMetaByIdentity = {
      'wt2:local:a': { hostId: 'local', instanceId: 'a' },
      'wt2:local:b': { hostId: 'local', instanceId: 'b' }
    } as never
    const before = JSON.stringify(data)
    const result = collectWorktreeInventoryRecords(data, 'repo', 'local')
    expect(result.ambiguous).toBe(true)
    expect(result.records.filter((row) => row.source === 'identity-alias')).toHaveLength(2)
    expect(result.records.filter((row) => row.source === 'canonical-metadata')).toHaveLength(2)
    expect(
      result.records.find((row) => row.sourceKey === 'wt2:local:a')?.relatedWorktreeIds
    ).toEqual(['/gone', '/old-name'].map((path) => `repo::${path}`))
    expect(JSON.stringify(data)).toBe(before)
  })

  it('unreferenced canonical metadata and dangling aliases prevent empty authority', () => {
    const data = state()
    data.worktreeMetaByIdentity = {
      'wt2:local:lost': { hostId: 'local', instanceId: 'lost' }
    } as never
    data.worktreeIdentityAliases = { 'local|repo::/dangling': ['wt2:local:absent'] }
    const result = collectWorktreeInventoryRecords(data, 'repo', 'local')
    expect(result).toMatchObject({ ambiguous: true })
    expect(result.records).toContainEqual(
      expect.objectContaining({ sourceKey: 'wt2:local:lost', worktreeId: null })
    )
    expect(result.records).toContainEqual(
      expect.objectContaining({ source: 'identity-alias', worktreeId: 'repo::/dangling' })
    )
  })

  it('preserves lineage even when neither endpoint has metadata or a checkout', () => {
    const data = state()
    data.worktreeLineageById['repo::/child'] = {
      worktreeId: 'repo::/child',
      worktreeInstanceId: 'a',
      parentWorktreeId: 'repo::/parent',
      parentWorktreeInstanceId: 'b',
      origin: 'cli'
    } as never
    data.workspaceLineageByChildKey['worktree:other::/child'] = {
      childWorkspaceKey: 'worktree:other::/child',
      parentWorkspaceKey: 'worktree:repo::/parent',
      parentInstanceId: 'b'
    } as never
    const before = JSON.stringify(data)
    const result = collectWorktreeInventoryRecords(data, 'repo', 'local')
    expect(result.ambiguous).toBe(true)
    expect(result.records).toContainEqual(
      expect.objectContaining({
        source: 'worktree-lineage',
        relatedWorktreeIds: ['repo::/child', 'repo::/parent'],
        lineage: data.worktreeLineageById['repo::/child']
      })
    )
    expect(result.records).toContainEqual(
      expect.objectContaining({
        source: 'workspace-lineage',
        relatedWorktreeIds: ['repo::/parent']
      })
    )
    expect(JSON.stringify(data)).toBe(before)
  })

  it('does not project another host or repo into an otherwise empty scope', () => {
    const data = state()
    data.worktreeMeta = {
      'repo::/foreign': { hostId: 'ssh:other' },
      'other::/local': { hostId: 'local' }
    } as never
    data.worktreeMetaByIdentity = {
      'wt2:ssh%3Aother:a': { hostId: 'ssh:other', instanceId: 'a' }
    } as never
    data.worktreeIdentityAliases = { 'ssh:other|repo::/foreign': ['wt2:ssh%3Aother:a'] }
    expect(collectWorktreeInventoryRecords(data, 'repo', 'local')).toEqual({
      records: [],
      ambiguous: false
    })
  })

  it('unknown legacy host and contradictory canonical key fail closed', () => {
    const data = state()
    data.worktreeMeta = { 'repo::/legacy': { instanceId: 'legacy' } } as never
    expect(collectWorktreeInventoryRecords(data, 'repo', 'local').ambiguous).toBe(true)
    data.worktreeMeta = {}
    data.worktreeMetaByIdentity = {
      'wt2:ssh%3Aother:a': { hostId: 'local', instanceId: 'a' }
    } as never
    data.worktreeIdentityAliases = { 'local|repo::/wrong': ['wt2:ssh%3Aother:a'] }
    expect(collectWorktreeInventoryRecords(data, 'repo', 'local').ambiguous).toBe(true)
  })
  it('retains session-only owners and partition provenance without private content', () => {
    const data = state()
    data.workspaceSession = {
      tabsByWorktree: {
        'repo::/session-only': [{ worktreeId: 'repo::/session-only', title: 'PRIVATE-TITLE' }]
      }
    } as never
    data.workspaceSessionsByHostId = {
      'ssh:remote': {
        unifiedTabs: { 'worktree:repo::/remote-only': [{ worktreeId: 'repo::/remote-only' }] }
      }
    } as never
    const before = JSON.stringify(data)
    const result = collectWorktreeInventoryRecords(data, 'repo', 'local')
    expect(result.records).toContainEqual(
      expect.objectContaining({
        source: 'workspace-session',
        worktreeId: 'repo::/session-only',
        partitionHostId: 'local',
        hostId: null
      })
    )
    expect(result.records.some((row) => row.worktreeId === 'repo::/remote-only')).toBe(false)
    expect(result.ambiguous).toBe(true)
    expect(JSON.stringify(result)).not.toContain('PRIVATE-TITLE')
    expect(JSON.stringify(data)).toBe(before)
  })
})

it.each([
  ['wt2:local:a', 'local'],
  ['wt2:local:a', 'ssh:remote'],
  ['wt2:ssh%3Aremote:a', 'local']
])('retains contradictory host references from canonical key %s and metadata %s', (key, hostId) => {
  const data = state()
  data.worktreeMetaByIdentity = { [key]: { hostId, instanceId: 'a' } } as never
  data.worktreeIdentityAliases = { 'ssh:remote|repo::/gone': [key] }
  const before = JSON.stringify(data)
  const result = collectWorktreeInventoryRecords(data, 'repo', 'local')
  expect(result.ambiguous).toBe(true)
  expect(result.records).toContainEqual(
    expect.objectContaining({ sourceKey: key, relatedWorktreeIds: ['repo::/gone'] })
  )
  expect(JSON.stringify(data)).toBe(before)
})

it('excludes canonical local records whose aliases all belong to another repo', () => {
  const data = state()
  data.projects = [
    { id: 'project', sourceRepoIds: ['repo'] },
    { id: 'other-project', sourceRepoIds: ['other'] }
  ] as never
  data.projectHostSetups = [
    { id: 'setup', repoId: 'repo', hostId: 'local' },
    { id: 'other-setup', repoId: 'other', hostId: 'local' }
  ] as never
  data.worktreeMetaByIdentity = {
    'wt2:local:a': {
      hostId: 'local',
      instanceId: 'a',
      projectId: 'other-project',
      projectHostSetupId: 'other-setup'
    }
  } as never
  data.worktreeIdentityAliases = { 'local|other::/gone': ['wt2:local:a'] }
  expect(collectWorktreeInventoryRecords(data, 'repo', 'local')).toEqual({
    records: [],
    ambiguous: false
  })
})
