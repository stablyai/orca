import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { createMobileRpcSurfaceRuntime } from './runtime-rpc-mobile-method-allowlist-fixtures'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest,
  waitForWsClose
} from './runtime-rpc-mobile-ws-test-harness'

it('lets a paired phone read the project name on its workspace host', async () => {
  const path = mkdtempSync(join(tmpdir(), 'orca-mobile-project-name-'))
  const { runtime } = createMobileRpcSurfaceRuntime()
  Object.assign(runtime, {
    showRepo: ({ selector, hostId }: { selector: string; hostId?: string }) =>
      selector === 'id:repo-1' && hostId === 'ssh:build-host'
        ? { id: 'repo-1', displayName: 'orca', externalWorktreeVisibility: 'hide' }
        : null
  })
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: path,
    enableWebSocket: true,
    wsPort: 0,
    pinnedBindHost: '127.0.0.1'
  })
  try {
    await server.start()
    const offer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'phone',
      scope: 'mobile',
      reach: 'this-computer'
    })
    if (!offer.available) {
      throw new Error(`Pairing unavailable: ${offer.reason}`)
    }
    const phone = await authenticateMobileWsSession(offer.pairingUrl)
    const replies = createEncryptedWsResponseReader(phone)
    try {
      sendEncryptedWsRequest(phone, {
        id: 'project-name',
        method: 'repo.show',
        params: { repo: 'id:repo-1', repoHostId: 'ssh:build-host' }
      })
      expect(await replies.next('project-name')).toMatchObject({
        id: 'project-name',
        ok: true,
        result: { repo: { displayName: 'orca' } }
      })
    } finally {
      replies.dispose()
      phone.ws.close()
      await waitForWsClose(phone.ws)
    }
  } finally {
    await server.stop()
    rmSync(path, { recursive: true, force: true })
  }
})
