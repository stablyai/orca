import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import '../../../../shared/remote-runtime/host-store/runtime-e2ee-keypair-file'
import { OrcaRuntimeService } from '../../orca-runtime'
import { PAIRING_METHODS } from '../methods/pairing/pairing'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { sendRequest } from './runtime-rpc-test-harness'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest,
  waitForWsClose
} from './runtime-rpc-mobile-ws-test-harness'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: vi.fn().mockResolvedValue([])
}))

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const mintedOffer = {
  available: true,
  pairingUrl: expect.stringMatching(/^orca:/),
  endpoint: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:/),
  deviceId: expect.any(String),
  webClientUrl: null
}

async function startServer(): Promise<{ server: OrcaRuntimeRpcServer; userDataPath: string }> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-headless-create-offer-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    methods: PAIRING_METHODS,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  return { server, userDataPath }
}

describe('headless pairing.createOffer', () => {
  it('mints a runtime grant on the authenticated Unix socket', async () => {
    const { server, userDataPath } = await startServer()
    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const response = await sendRequest(metadata!.transports[0]!.endpoint, {
        id: 'req_pairing_create',
        authToken: metadata!.authToken,
        method: 'pairing.createOffer',
        params: { address: '127.0.0.1', scope: 'runtime' }
      })
      expect(response).toMatchObject({
        id: 'req_pairing_create',
        ok: true,
        result: mintedOffer
      })
    } finally {
      await server.stop()
    }
  })

  it('does not let a paired runtime socket mint another grant', async () => {
    // Why: pairing-admin stays with the host owner. A paired runtime client is not that owner.
    const { server } = await startServer()
    const offer = server.createPairingOffer({ address: '127.0.0.1', scope: 'runtime' })
    if (!offer.available) {
      throw new Error('WebSocket pairing unavailable')
    }
    const session = await authenticateMobileWsSession(offer.pairingUrl)
    const reader = createEncryptedWsResponseReader(session)
    try {
      sendEncryptedWsRequest(session, {
        id: 'create-offer-1',
        method: 'pairing.createOffer',
        params: { address: '127.0.0.1', scope: 'runtime' }
      })
      await expect(reader.next('create-offer-1')).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'forbidden',
          message: expect.stringContaining('pairing-admin')
        }
      })
    } finally {
      reader.dispose()
      session.ws.close()
      await waitForWsClose(session.ws)
      await server.stop()
    }
  })
})
