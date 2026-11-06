import '../unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAttentionOrigin } from '../../../../shared/agent-session/agent-session-attention'
import {
  getStructuredAgentSessionHost,
  setStructuredAgentSessionHost
} from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { RuntimeMobileNotificationController } from '../../push/notifications/runtime-mobile-notification-controller'
import {
  call,
  clearStructuredHostStub,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

let directory: string
let hostController: RuntimeMobileNotificationController | undefined
beforeEach(() => {
  installStructuredHostStub()
  directory = mkdtempSync(join(tmpdir(), 'orca-attention-ack-'))
})
afterEach(async () => {
  clearStructuredHostStub()
  await hostController?.closeDismissals()
  hostController = undefined
  rmSync(directory, { recursive: true, force: true })
})

type HostId = StructuredAttentionOrigin['scope']['executionHostId']
const scope = (executionHostId: HostId): StructuredAttentionOrigin['scope'] => ({
  executionHostId,
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
})

/** This host's store holding deliveries for several sessions, scopes and journal positions. */
function hostWithDeliveries() {
  const controller = new RuntimeMobileNotificationController()
  controller.configureDismissalStore(directory)
  hostController = controller
  const dismissed: string[] = []
  controller.onDispatched((event) => {
    if (event.type === 'dismiss') {
      dismissed.push(event.notificationId)
    }
  })
  const deliver = (id: string, origin: StructuredAttentionOrigin) =>
    controller.dispatch({
      type: 'notification',
      source: 'agent-task-complete',
      title: id,
      body: '',
      notificationId: id,
      structuredOrigin: origin
    })
  const prompt = (sessionId: string, epoch: string, sequence: number, host: HostId = 'local') => ({
    scope: scope(host),
    sessionId,
    cause: { kind: 'prompt' as const, promptId: `${sessionId}-${sequence}` },
    journalCursor: { epoch, sequence }
  })
  deliver('read', prompt(SESSION, 'journal-a', 5))
  deliver('newer', prompt(SESSION, 'journal-a', 20))
  deliver('other-session', prompt('session-2', 'journal-b', 5))
  // Restored host copies may share both session identity and journal epoch.
  deliver('other-scope', prompt(SESSION, 'journal-a', 5, 'runtime:remote'))
  return { controller, dismissed, deliver }
}

describe('agentSession.acknowledgeAttention', () => {
  it('retires the deliveries the read covers without installing a host', async () => {
    setStructuredAgentSessionHost(null)
    const install = vi.fn()
    const { controller, dismissed } = hostWithDeliveries()
    const reply = await call(
      'agentSession.acknowledgeAttention',
      { sessionId: SESSION, observedCursor: { epoch: 'journal-a', sequence: 10 } },
      STRUCTURED_CLIENT,
      {
        acknowledgeNotificationAttention: controller.acknowledgeAttention.bind(controller),
        openAgentSessionRecordStore: async () => ({
          getConversation: () => ({ location: scope('local') })
        }),
        ensureStructuredAgentSessionHost: install
      }
    )
    expect(reply).toMatchObject({ ok: true, result: { acknowledged: true } })
    expect(install).not.toHaveBeenCalled()
    // A newer prompt, another session and another scope's journal all stay live.
    expect(dismissed).toEqual(['read'])
  })

  it('refuses a read without its journal boundary or with unknown fields, before any work', async () => {
    const retire = vi.fn()
    for (const params of [
      { sessionId: SESSION },
      { sessionId: SESSION, observedCursor: { epoch: 'journal-a', sequence: 10 }, extra: true }
    ]) {
      const reply = await call('agentSession.acknowledgeAttention', params, STRUCTURED_CLIENT, {
        acknowledgeNotificationAttention: retire
      })
      expect(reply).toMatchObject({ ok: false })
    }
    expect(retire).not.toHaveBeenCalled()
  })

  it('uses the installed session location to preserve an identical journal in another WSL scope', async () => {
    const { controller, dismissed, deliver } = hostWithDeliveries()
    const host = getStructuredAgentSessionHost()
    if (!host) {
      throw new Error('host stub not installed')
    }
    vi.spyOn(host.attentionReads, 'sessionLocation').mockReturnValue(scope('local'))
    deliver('wsl-copy', {
      scope: { ...scope('local'), wslDistro: 'Ubuntu' },
      sessionId: SESSION,
      cause: { kind: 'prompt', promptId: 'copy' },
      journalCursor: { epoch: 'journal-a', sequence: 5 }
    })

    const reply = await call(
      'agentSession.acknowledgeAttention',
      { sessionId: SESSION, observedCursor: { epoch: 'journal-a', sequence: 10 } },
      STRUCTURED_CLIENT,
      { acknowledgeNotificationAttention: controller.acknowledgeAttention.bind(controller) }
    )

    expect(reply).toMatchObject({ ok: true, result: { acknowledged: true } })
    expect(dismissed).toEqual(['read'])
  })

  it('rejects a caller without structured capability before any work', async () => {
    setStructuredAgentSessionHost(null)
    const install = vi.fn()
    const retire = vi.fn()
    const reply = await call(
      'agentSession.acknowledgeAttention',
      { sessionId: SESSION, observedCursor: { epoch: 'journal-a', sequence: 10 } },
      { clientKind: 'runtime', clientCapabilities: [] },
      { acknowledgeNotificationAttention: retire, ensureStructuredAgentSessionHost: install }
    )
    expect(reply).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
    expect(install).not.toHaveBeenCalled()
    expect(retire).not.toHaveBeenCalled()
  })
})
