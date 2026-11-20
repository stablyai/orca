import { expect, it } from 'vitest'
import { classifyWorkerPlacementCatalog } from './worker-placement-eligibility'
import {
  readPlacementCatalogList,
  reducePlacementCatalog,
  type PlacementCatalogSetup
} from './worker-placement-catalog'

const repo = { id: 'repo', path: '/repo', displayName: 'repo' }
const setup: PlacementCatalogSetup = {
  id: 'setup',
  projectId: 'github:team/repo',
  repoId: 'repo',
  hostId: 'local',
  path: '/repo',
  displayName: 'repo',
  setupState: 'ready',
  workerExecutionTarget: { kind: 'native' }
}

it.each([
  { name: 'native', changes: {}, reason: null },
  {
    name: 'omitted target',
    changes: { workerExecutionTarget: undefined },
    reason: 'unsupported_target'
  },
  {
    name: 'unknown target',
    changes: { workerExecutionTarget: { kind: 'unknown' as const } },
    reason: 'unsupported_target'
  },
  {
    name: 'WSL target',
    changes: { workerExecutionTarget: { kind: 'wsl' as const } },
    reason: 'unsupported_target'
  },
  { name: 'empty checkout', changes: { repoId: '' }, reason: 'no_checkout' },
  { name: 'missing checkout', changes: { repoId: 'gone' }, reason: 'no_checkout' },
  { name: 'not ready', changes: { setupState: 'error' as const }, reason: 'not_ready' },
  { name: 'folder', changes: { kind: 'folder' as const }, reason: 'folder' },
  { name: 'SSH setup', changes: { hostId: 'ssh:box' }, reason: 'ssh_host' },
  { name: 'runtime setup', changes: { hostId: 'runtime:box' }, reason: 'other_runtime' }
])('classifies original owner rows: $name', ({ changes, reason }) => {
  const [result] = classifyWorkerPlacementCatalog({
    repos: [repo],
    setups: [{ ...setup, ...changes }]
  })
  expect(result.explicitStart).toEqual(reason ? { usable: false, reason } : { usable: true })
  expect(result.automaticPlacement).toEqual({ available: false, reason: reason ?? 'explicit_only' })
})

it('counts repo twins before host filtering and preserves independent usable checkouts', () => {
  const results = classifyWorkerPlacementCatalog({
    repos: [repo, { ...repo, connectionId: 'box' }, { ...repo, id: 'second' }],
    setups: [
      setup,
      { ...setup, id: 'second-setup', repoId: 'second' },
      { ...setup, id: 'placeholder', repoId: '' }
    ]
  })
  expect(results.map((result) => result.explicitStart)).toEqual([
    { usable: false, reason: 'duplicate_repo_id' },
    { usable: true },
    { usable: false, reason: 'no_checkout' }
  ])
})

it('rejects malformed lists without salvaging or manufacturing local hosts', () => {
  expect(reducePlacementCatalog([repo], [{ ...setup, hostId: undefined }])).toBeNull()
  expect(reducePlacementCatalog([repo, { id: 1 }], [setup])).toBeNull()
  expect(readPlacementCatalogList({ setups: Array(5_001).fill(null) }, 'setups')).toEqual({
    ok: false,
    reason: 'oversized'
  })
  expect(
    readPlacementCatalogList({ repos: [repo], extra: 'x'.repeat(2_097_152) }, 'repos')
  ).toEqual({ ok: false, reason: 'oversized' })
  const invalid = reducePlacementCatalog(
    [repo],
    [{ ...setup, workerExecutionTarget: { kind: 'claimed-native' } }]
  )!
  expect(classifyWorkerPlacementCatalog(invalid)[0].explicitStart).toEqual({
    usable: false,
    reason: 'unsupported_target'
  })
})
