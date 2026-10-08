import { describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import type { StructuredChatNamingDeps } from './structured-chat-naming'
import { createStructuredChatNamingHandler } from './structured-chat-naming'
import { firstStructuredChatNamingPrompt } from '../../shared/structured-chat-naming-eligibility'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../shared/agent-session-provider-handle-encoding'
import {
  hostTestState,
  envelope
} from './agent-session-wire/structured-agent-session-host-test-harness'
import {
  hostTestAttachParams,
  hostTestMessage,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from './agent-session-wire/structured-agent-session-host-test-data'

describe.each(['claude', 'codex'] as const)('%s first-message naming status hook', (provider) => {
  it.each([
    { outcome: 'accepted', completesDuringRead: false },
    { outcome: 'admitted', completesDuringRead: false },
    { outcome: 'accepted', completesDuringRead: true },
    { outcome: 'admitted', completesDuringRead: true }
  ] as const)(
    'names a live $outcome send (first turn completes during journal read: $completesDuringRead)',
    async ({ outcome, completesDuringRead }) => {
      const { host, store, acquire, dispatch, log } = hostTestState()
      const handle =
        provider === 'claude'
          ? claudeProviderHandle(HOST_TEST_THREAD, null)
          : codexProviderHandle(HOST_TEST_THREAD)
      acquire.mockImplementation(async ({ fence }) => ({
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken: store.getRecord(HOST_TEST_SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
        },
        link: {
          linkId: `link-${fence}`,
          handle,
          origin: 'created',
          mintedAtFence: fence,
          observedAt: 100
        }
      }))
      dispatch.mockImplementation(async () =>
        outcome === 'admitted'
          ? { state: 'admitted' }
          : {
              state: 'accepted',
              providerIdentity:
                provider === 'claude'
                  ? { provider: 'claude', sessionId: HOST_TEST_THREAD, uuid: 'turn-1' }
                  : { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-1', ordinal: 1 }
            }
      )
      let finish: (value: string | null) => void = () => {
        throw new Error('Not initialized')
      }
      const generation = new Promise<string | null>((resolve) => {
        finish = resolve
      })
      const journalRead = Promise.withResolvers<void>()
      const readFirstPrompt = vi.fn(async (sessionId: string, hostStartedAt: number) => {
        await journalRead.promise
        return firstStructuredChatNamingPrompt(await host.journalSnapshot(sessionId), hostStartedAt)
      })
      const generate = vi.fn(() => generation)
      const deps: StructuredChatNamingDeps = {
        getStore: () => store,
        getSettings: () => ({}),
        hasOpenDispatch: () => false,
        readFirstPrompt,
        generate,
        onNamed: vi.fn(),
        logger: log.logger
      }
      const naming = createStructuredChatNamingHandler(deps)
      const status = vi.fn(naming)
      host.deps.onSessionStatusChanged = status
      const attached = await host.attach(
        { callerKey: 'client-1' },
        hostTestAttachParams(null, {
          provider,
          agent: provider,
          providerHandle:
            provider === 'claude'
              ? { kind: 'claude', sessionId: HOST_TEST_THREAD, leafUuid: null }
              : { kind: 'codex', threadId: HOST_TEST_THREAD },
          accountHome: {
            variable: provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
            path: '/isolated/account'
          }
        })
      )
      expect(attached).toMatchObject({ ok: true })
      const body = hostTestMessage('Please repair the login flow')
      const sent = await host.send(
        { callerKey: 'client-1' },
        {
          envelope: envelope('agentSession.send', { body }),
          body
        }
      )
      expect(sent).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(readFirstPrompt).toHaveBeenCalledTimes(1))
      expect(generate).not.toHaveBeenCalled()
      if (completesDuringRead) {
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
        const events = acquire.mock.calls.at(-1)?.[0].events
        const first = (await host.journalSnapshot(HOST_TEST_SESSION)).items.find(
          (item) => item.body.kind === 'message' && item.body.role === 'user'
        )
        if (!events || !first) {
          throw new Error('Missing acquired first turn')
        }
        events.appendItem(
          provider === 'claude'
            ? { provider: 'claude', sessionId: HOST_TEST_THREAD, uuid: 'turn-1' }
            : { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-1', ordinal: 1 },
          body,
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        events.appendItem(
          provider === 'claude'
            ? { provider: 'claude', sessionId: HOST_TEST_THREAD, uuid: 'turn-completion' }
            : { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-1', ordinal: 2 },
          { kind: 'turn', turnId: 'turn-1', userItemId: first.itemId, state: 'completed' },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        events.publish()
        await host.flushStreamedEvents(HOST_TEST_SESSION)
        await vi.waitFor(() =>
          expect(status.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'idle' })
        )
        expect(generate).not.toHaveBeenCalled()
        expect(store.getRecord(HOST_TEST_SESSION)?.conversationName).toBeUndefined()
      }
      journalRead.resolve()
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
      expect(
        status.mock.calls.some(
          ([summary, options]) =>
            summary.agent === provider && summary.status === 'working' && !options.replay
        )
      ).toBe(true)
      expect(store.getRecord(HOST_TEST_SESSION)?.conversationName).toBeUndefined()
      finish('auth/login')
      await vi.waitFor(() =>
        expect(store.getRecord(HOST_TEST_SESSION)?.conversationName).toBe('auth/login')
      )
    }
  )
})
