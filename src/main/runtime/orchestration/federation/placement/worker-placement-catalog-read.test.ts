import { expect, it } from 'vitest'
import type { OrchestrationEnvironmentTransport } from '../environment-transport'
import { readWorkerPlacementCatalog } from './worker-placement-catalog-read'

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
