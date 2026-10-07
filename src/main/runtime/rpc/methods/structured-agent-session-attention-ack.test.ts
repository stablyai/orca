import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAttentionOrigin } from '../../../../shared/agent-session-attention'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { RuntimeMobileNotificationController } from '../../runtime-mobile-notification-controller'
import {
  call,
  clearStructuredHostStub,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

let directory: string
beforeEach(() => {
  installStructuredHostStub()
  directory = mkdtempSync(join(tmpdir(), 'orca-attention-ack-'))
})
afterEach(() => {
  clearStructuredHostStub()
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
  // Another scope's journal for the same session id mints its own epoch.
  deliver('other-scope', prompt(SESSION, 'journal-c', 5, 'runtime:remote'))
  return { controller, dismissed }
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
        retireStructuredAttention: controller.retireStructuredAttention.bind(controller),
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
        retireStructuredAttention: retire
      })
      expect(reply).toMatchObject({ ok: false })
    }
    expect(retire).not.toHaveBeenCalled()
  })

  it('rejects a caller without structured capability before any work', async () => {
    setStructuredAgentSessionHost(null)
    const install = vi.fn()
    const retire = vi.fn()
    const reply = await call(
      'agentSession.acknowledgeAttention',
      { sessionId: SESSION, observedCursor: { epoch: 'journal-a', sequence: 10 } },
      { clientKind: 'runtime', clientCapabilities: [] },
      { retireStructuredAttention: retire, ensureStructuredAgentSessionHost: install }
    )
    expect(reply).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
    expect(install).not.toHaveBeenCalled()
    expect(retire).not.toHaveBeenCalled()
  })
})
