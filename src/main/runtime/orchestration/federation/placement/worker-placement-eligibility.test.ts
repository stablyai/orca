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

it.each([
  { repoPath: '', setupPath: '/repo' },
  { repoPath: '/repo', setupPath: '' }
])('requires both checkout paths: $repoPath, $setupPath', ({ repoPath, setupPath }) => {
  const [result] = classifyWorkerPlacementCatalog({
    repos: [{ ...repo, path: repoPath }],
    setups: [{ ...setup, path: setupPath }]
  })
  expect(result.explicitStart).toEqual({ usable: false, reason: 'no_checkout' })
})

it.each([
  { name: 'legacy absent repo host', repoHost: {}, setupHost: {}, reason: null },
  {
    name: 'legacy null repo host',
    repoHost: { executionHostId: null, connectionId: null },
    setupHost: {},
    reason: null
  },
  {
    name: 'explicit local agreement',
    repoHost: { executionHostId: 'local' },
    setupHost: { executionHostId: 'local' },
    reason: null
  },
  {
    name: 'local repo with SSH connection',
    repoHost: { executionHostId: 'local', connectionId: 'box' },
    setupHost: {},
    reason: 'ssh_host'
  },
  {
    name: 'legacy SSH repo',
    repoHost: { connectionId: 'box' },
    setupHost: {},
    reason: 'ssh_host'
  },
  ...(['ssh:', 'ssh:%'] as const).map((executionHostId) => ({
    name: `malformed repo host ${executionHostId}`,
    repoHost: { executionHostId },
    setupHost: {},
    reason: 'ssh_host'
  })),
  ...(['runtime:', 'runtime:%E0%A4%A'] as const).map((executionHostId) => ({
    name: `malformed repo host ${executionHostId}`,
    repoHost: { executionHostId },
    setupHost: {},
    reason: 'other_runtime'
  })),
  {
    name: 'explicit blank repo host',
    repoHost: { executionHostId: '' },
    setupHost: {},
    reason: 'ssh_host'
  },
  {
    name: 'explicit blank setup execution host',
    repoHost: {},
    setupHost: { executionHostId: '' },
    reason: 'other_runtime'
  },
  {
    name: 'whitespace SSH connection',
    repoHost: { connectionId: ' ' },
    setupHost: {},
    reason: 'ssh_host'
  },
  {
    name: 'SSH repo with local setup',
    repoHost: { executionHostId: 'ssh:box' },
    setupHost: {},
    reason: 'ssh_host'
  },
  {
    name: 'runtime repo with local setup',
    repoHost: { executionHostId: 'runtime:box' },
    setupHost: {},
    reason: 'other_runtime'
  },
  {
    name: 'local setup with SSH connection',
    repoHost: {},
    setupHost: { connectionId: 'box' },
    reason: 'ssh_host'
  },
  {
    name: 'local setup with SSH execution host',
    repoHost: {},
    setupHost: { executionHostId: 'ssh:box' },
    reason: 'ssh_host'
  },
  {
    name: 'local setup with runtime execution host',
    repoHost: {},
    setupHost: { executionHostId: 'runtime:box' },
    reason: 'other_runtime'
  }
])(
  'requires original host agreement despite native evidence: $name',
  ({ repoHost, setupHost, reason }) => {
    const [result] = classifyWorkerPlacementCatalog({
      repos: [{ ...repo, ...repoHost }],
      setups: [{ ...setup, ...setupHost }]
    })
    expect(result.explicitStart).toEqual(reason ? { usable: false, reason } : { usable: true })
    expect(result.automaticPlacement).toEqual({
      available: false,
      reason: reason ?? 'explicit_only'
    })
  }
)

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
