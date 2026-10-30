import '../unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  attach,
  hostTestState
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import * as journalFactory from '../../../native-chat/agent-session-journal/journal-store-factory'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { STRUCTURED_AGENT_SESSION_STATUS_METHODS } from './structured-agent-session-status-stream'

afterEach(() => {
  setStructuredAgentSessionHost(null)
  vi.restoreAllMocks()
})

it.each(['mobile', 'runtime'] as const)(
  'gives a first %s connection its saved snapshot without opening history',
  async (clientKind) => {
    await attach()
    const { host: previous, store } = hostTestState()
    await previous.flushAllStreamedEvents()
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lastTurn: { state: 'settled', outcome: 'success', at: 100 }
    }))
    await store.setSessionTabVisibility(SESSION, true)
    const host = new StructuredAgentSessionHost(previous.deps)
    setStructuredAgentSessionHost(host)
    const open = vi.spyOn(journalFactory, 'openAgentSessionJournal')
    const emit = vi.fn()
    const cleanups: (() => void)[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this RPC reads only startup preparation and stream cleanup from the runtime.
    const runtime = {
      getRuntimeId: () => 'restarted-orcad',
      getClientSettings: () => ({}),
      restoreStructuredAgentSessionTabs: () => host.seedSessionTabs(),
      registerSubscriptionCleanup: (_id: string, cleanup: () => void) => cleanups.push(cleanup),
      cleanupSubscription: () => cleanups.forEach((cleanup) => cleanup())
    } as unknown as OrcaRuntimeService
    try {
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: STRUCTURED_AGENT_SESSION_STATUS_METHODS
      })
      await dispatcher.dispatchStreaming(
        { id: 'first', authToken: 'token', method: 'agentSession.subscribeStatus', params: null },
        (raw) => emit(JSON.parse(raw)),
        { clientKind, clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] }
      )
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            type: 'snapshot',
            sessions: [
              expect.objectContaining({
                sessionId: SESSION,
                turnOutcome: 'success',
                statusStartedAt: 100
              })
            ]
          })
        })
      )
      expect(open).not.toHaveBeenCalled()
      expect(host.hasSession(SESSION)).toBe(false)
    } finally {
      cleanups.forEach((cleanup) => cleanup())
      await host.flushAllStreamedEvents()
    }
  }
)
