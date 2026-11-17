import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import 'tweetnacl'
import { describe, expect, it } from 'vitest'
import '../../../../shared/remote-runtime/pairing/device-key-proof'
import './pairing/device-principal'
import './pairing/device-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

import { visibleSnapshot } from '../methods/session-tabs/session-tabs-snapshot.test-fixture'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest
} from './runtime-rpc-mobile-ws-test-harness'

describe('streams on an authenticated phone socket', () => {
  it('re-project when the phone later updates its capabilities on that socket', async () => {
    const snapshot = {
      ...visibleSnapshot(),
      tabs: [
        {
          type: 'agent-session' as const,
          id: 'claude',
          sessionId: 'claude-session',
          agent: 'claude',
          title: 'Claude chat',
          isActive: true
        }
      ]
    }
    const cleanups = new Map<string, () => void>()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: phone auth and session.tabs.subscribe read only these members.
    const runtime = {
      configureNotificationDismissalStore: () => {},
      getRuntimeId: () => 'test-runtime',
      getStartedAt: () => 1,
      machineNameReady: async () => undefined,
      getStatus: () => ({ graphStatus: 'unavailable' }),
      onClientDisconnected: () => {},
      cleanupSubscriptionsForConnection: () => {},
      listMobileSessionTabs: async () => snapshot,
      registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
      cleanupSubscription: (id: string) => cleanups.get(id)?.(),
      onMobileSessionTabsChanged: () => () => {}
    } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-phone-capability-dispatch-')),
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    const offer = server.createPairingOffer({ address: '127.0.0.1', name: 'p', scope: 'mobile' })
    if (!offer.available) {
      throw new Error('WebSocket pairing unavailable')
    }
    // Token auth carries no capabilities, as a phone's does before its advisory update.
    const session = await authenticateMobileWsSession(offer.pairingUrl)
    const reader = createEncryptedWsResponseReader(session)
    try {
      sendEncryptedWsRequest(session, {
        id: 'tabs',
        method: 'session.tabs.subscribe',
        params: { worktree: 'id:wt-1' }
      })
      expect(JSON.stringify(await reader.next('tabs'))).toContain('Open on desktop')
      sendEncryptedWsRequest(session, {
        id: 'caps',
        method: 'runtime.clientCapabilities.update',
        params: {
          clientCapabilities: ['agent-session.structured.v1', 'agent-session.structured.claude.v1']
        }
      })
      const recovered = await reader.next('tabs')
      expect(recovered).toMatchObject({ result: { type: 'updated' } })
      expect(JSON.stringify(recovered)).toContain('Claude chat')
    } finally {
      reader.dispose()
      session.ws.close()
      await server.stop()
    }
  })
})
