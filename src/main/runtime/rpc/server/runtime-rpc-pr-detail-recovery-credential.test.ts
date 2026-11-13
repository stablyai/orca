import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { GITHUB_PR_DETAIL_RECOVERY_METHODS } from '../methods/source-control/github/github-pr-detail-recovery-methods'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest
} from './runtime-rpc-mobile-ws-test-harness'

it('refuses recovery if the paired credential is revoked while its candidate lookup awaits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-pr-recovery-credential-'))
  const runtime = new OrcaRuntimeService()
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const resolving = new Promise<void>((resolve) => {
    entered = resolve
  })
  const resolver = vi
    .spyOn(runtime, 'resolvePRDetailRecoveryCandidate')
    .mockImplementation(async () => {
      entered()
      await held
      return {
        cacheKey: '/repo::feature',
        repoKind: 'git',
        repoId: 'repo',
        repoPath: '/repo',
        branch: 'feature',
        fallbackPRNumber: 7
      }
    })
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: directory,
    enableWebSocket: true,
    wsPort: 0,
    methods: GITHUB_PR_DETAIL_RECOVERY_METHODS
  })
  await server.start()
  const offer = server.createPairingOffer({
    address: '127.0.0.1',
    name: 'Browser',
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  const session = await authenticateMobileWsSession(offer.pairingUrl)
  const reader = createEncryptedWsResponseReader(session)
  try {
    sendEncryptedWsRequest(session, {
      id: 'start',
      method: 'github.prDetailRecovery.start',
      params: {
        clientEpoch: { scope: 'g1000.panel', counter: 1 },
        cacheKey: '/repo::feature',
        identity: {
          sourceEpoch: 'runtime:test',
          repoId: 'repo',
          repoPath: '/repo',
          worktreeId: 'wt-1',
          branch: 'feature',
          currentHeadOid: 'h2',
          executionHostId: null,
          provider: 'github',
          linkedPRNumber: null,
          fallbackPRNumber: 7,
          fallbackPRSource: 'hosted-review',
          selectionRevision: ''
        }
      }
    })
    const response = reader.next('start')
    await Promise.race([
      resolving,
      response.then((result) => {
        throw new Error(`Recovery refused before candidate resolution: ${JSON.stringify(result)}`)
      })
    ])
    server.getDeviceRegistry()?.removeDevice(offer.deviceId)
    release()
    expect(await response).toMatchObject({
      ok: true,
      result: { phase: 'terminal', terminal: { kind: 'not-admitted', reason: 'validation' } }
    })
  } finally {
    release()
    reader.dispose()
    session.ws.close()
    resolver.mockRestore()
    await server.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
