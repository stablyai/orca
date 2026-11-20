import { expect, it } from 'vitest'
import { readWorkerPlacementCatalog } from './worker-placement-catalog-read'
import type { OrchestrationEnvironmentTransport } from '../environment-transport'

const repo = { id: 'repo', path: '/repo', displayName: 'repo' }
const setup = {
  id: 'setup',
  projectId: 'github:team/repo',
  repoId: 'repo',
  hostId: 'local',
  path: '/repo',
  displayName: 'repo',
  setupState: 'ready',
  workerExecutionTarget: { kind: 'native' }
}

it.each(['ssh:', 'runtime:', 'ssh:%', 'runtime:%E0%A4%A', '', ' local', 'ssh:box|other'])(
  'treats malformed original host %j as incomplete rather than replacement data',
  async (hostId) => {
    for (const catalog of [
      { repos: [{ ...repo, executionHostId: hostId }], setups: [setup] },
      { repos: [repo], setups: [{ ...setup, hostId }] },
      { repos: [repo], setups: [{ ...setup, executionHostId: hostId }] }
    ]) {
      const transport: OrchestrationEnvironmentTransport = {
        list: async () => [],
        resolve: async () => {
          throw new Error('unused')
        },
        call: async (_id, method) => ({
          id: 'read',
          ok: true,
          result: method === 'repo.list' ? { repos: catalog.repos } : { setups: catalog.setups },
          _meta: { runtimeId: 'peer' }
        })
      }
      expect(
        await readWorkerPlacementCatalog(
          transport,
          {
            environmentId: 'server',
            name: 'server',
            peerFingerprint: 'peer',
            homePeerFingerprint: 'home',
            pairingRevision: 1
          },
          async () => () => true
        )
      ).toEqual({ kind: 'failed', reason: 'incomplete' })
    }
  }
)
