import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { parsePairingCode } from '../../shared/pairing'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import type { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

const TEST_TIMEOUT_MS = 15_000
const REQUEST_TIMEOUT_MS = 5_000

it(
  'binds encrypted close-intent capability to the real runtime RPC context',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-close-intent-'))
    const refuseUnattributedMobileSessionTabClose = vi.fn().mockResolvedValue({
      closed: true,
      refused: true,
      refusalReason: 'missing-intent',
      snapshotRepublished: true
    })
    const closeMobileSessionTab = vi.fn()
    const listMobileSessionTabs = vi.fn().mockResolvedValue({
      worktree: 'wt-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: 'tab-1::leaf-1',
      activeTabType: 'terminal',
      tabGroups: [{ id: 'group-1', activeTabId: 'tab-1', tabOrder: ['tab-1'] }],
      tabs: [
        {
          type: 'terminal',
          id: 'tab-1::leaf-1',
          parentTabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'Terminal',
          status: 'ready',
          terminal: 'pty-1',
          isActive: true
        }
      ]
    })
    const runtime = {
      getRuntimeId: () => 'close-intent-runtime-test',
      getStartedAt: () => 1,
      cleanupSubscriptionsForConnection: () => {},
      cancelMobileDictationForConnection: () => {},
      onClientDisconnected: () => {},
      listMobileSessionTabs,
      refuseUnattributedMobileSessionTabClose,
      closeMobileSessionTab
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
        await expect(
          connection.request(
            'session.tabs.close',
            { worktree: 'id:wt-1', tabId: 'tab-1' },
            REQUEST_TIMEOUT_MS
          )
        ).resolves.toMatchObject({
          ok: true,
          result: {
            refused: true,
            refusalReason: 'missing-intent',
            snapshotRepublished: true
          }
        })
        expect(listMobileSessionTabs).toHaveBeenCalledWith('id:wt-1', pairing.pairedDeviceId)
        expect(refuseUnattributedMobileSessionTabClose).toHaveBeenCalledWith('id:wt-1', 'tab-1')
        expect(closeMobileSessionTab).not.toHaveBeenCalled()
      } finally {
        connection.close()
      }
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }
)
