import { expect, it } from 'vitest'
import type { OrchestrationEnvironmentTransport } from '../environment-transport'
import { readWorkerPlacementCatalog } from './worker-placement-catalog-read'

it.each([
  {
    scenario: 'is unsupported when the repo-list runtime answers it',
    setupMeta: { runtimeId: 'peer' },
    expected: { kind: 'unsupported' }
  },
  {
    scenario: 'is incomplete when a restarted runtime answers it',
    setupMeta: { runtimeId: 'restarted' },
    expected: { kind: 'failed', reason: 'incomplete' }
  },
  {
    scenario: 'is incomplete without a runtime ID',
    setupMeta: { runtimeId: null },
    expected: { kind: 'failed', reason: 'incomplete' }
  },
  {
    scenario: 'is incomplete without runtime metadata',
    setupMeta: undefined,
    expected: { kind: 'failed', reason: 'incomplete' }
  }
])('a missing project API $scenario', async ({ setupMeta, expected }) => {
  const server = {
    environmentId: 'server',
    name: 'server',
    peerFingerprint: 'peer',
    homePeerFingerprint: 'home',
    pairingRevision: 1
  }
  const transport: OrchestrationEnvironmentTransport = {
    resolve: () => server,
    call: async (_id, method) =>
      method === 'repo.list'
        ? { id: 'repo-read', ok: true, _meta: { runtimeId: 'peer' }, result: { repos: [] } }
        : {
            id: 'setup-read',
            ok: false,
            error: { code: 'method_not_found', message: 'old peer' },
            ...(setupMeta ? { _meta: setupMeta } : {})
          }
  }

  expect(await readWorkerPlacementCatalog(transport, server, async () => () => true)).toEqual(
    expected
  )
})

it.each([
  {
    scenario: 'the paired runtime restarts between replies',
    repoRuntimeId: '3b66ee63-7f3f-4ee1-bccf-e3bd70870b34',
    setupRuntimeId: 'fb8ef5c3-0895-4193-b8cf-9f39546caa29'
  },
  { scenario: 'both replies carry an empty runtime ID', repoRuntimeId: '', setupRuntimeId: '' }
])('returns an incomplete catalog when $scenario', async ({ repoRuntimeId, setupRuntimeId }) => {
  const server = {
    environmentId: 'server',
    name: 'server',
    peerFingerprint: 'peer',
    homePeerFingerprint: 'home',
    pairingRevision: 1
  }
  const transport: OrchestrationEnvironmentTransport = {
    resolve: () => server,
    call: async (_id, method) =>
      method === 'repo.list'
        ? {
            id: 'repo-read',
            ok: true,
            _meta: { runtimeId: repoRuntimeId },
            result: { repos: [{ id: 'checkout', path: '/repo', displayName: 'repo' }] }
          }
        : {
            id: 'setup-read',
            ok: true,
            _meta: { runtimeId: setupRuntimeId },
            result: {
              setups: [
                {
                  id: 'setup',
                  projectId: 'github:team/repo',
                  repoId: 'checkout',
                  hostId: 'local',
                  path: '/repo',
                  displayName: 'repo',
                  setupState: 'ready',
                  workerExecutionTarget: { kind: 'native' }
                }
              ]
            }
          }
  }

  expect(await readWorkerPlacementCatalog(transport, server, async () => () => true)).toEqual({
    kind: 'failed',
    reason: 'incomplete'
  })
})
