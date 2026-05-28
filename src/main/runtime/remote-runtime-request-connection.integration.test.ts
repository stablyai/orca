import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { getDefaultRepoHookSettings } from '../../shared/constants'
import type { Repo } from '../../shared/types'
import { parsePairingCode } from '../../shared/pairing'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import type { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

describe('remote runtime request connection integration', () => {
  it('fetches repos through the real E2EE WebSocket runtime', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-request-'))
    const repoPath = join(userDataPath, 'repo')
    const repos: Repo[] = [
      {
        id: 'repo-1',
        path: repoPath,
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        hookSettings: getDefaultRepoHookSettings(),
        worktreeBaseRef: 'main',
        kind: 'git'
      }
    ]
    const runtime = {
      getRuntimeId: () => 'runtime-test',
      getStartedAt: () => 1,
      cleanupSubscriptionsForConnection: () => {},
      cancelMobileDictationForConnection: () => {},
      onClientDisconnected: () => {},
      listRepos: () => repos
    } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      const offer = server.createPairingOffer({ name: 'integration', scope: 'runtime' })
      if (!offer.available) {
        throw new Error('pairing unavailable')
      }
      const pairing = parsePairingCode(offer.pairingUrl)
      if (!pairing) {
        throw new Error('invalid pairing')
      }
      const connection = new RemoteRuntimeRequestConnection(pairing)
      try {
        await expect(connection.request('repo.list', undefined, 1000)).resolves.toMatchObject({
          ok: true,
          result: { repos }
        })
      } finally {
        connection.close()
      }
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
