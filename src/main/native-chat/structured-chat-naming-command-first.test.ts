import { describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../shared/agent-session-provider-handle-encoding'
import { createStructuredChatNamingHandler } from './structured-chat-naming'
import { firstStructuredChatNamingPrompt } from '../../shared/structured-chat-naming-eligibility'
import type { StructuredAgentSessionAdapter } from './agent-session-wire/structured-agent-session-adapter'
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

describe.each(['claude', 'codex'] as const)('%s command-first naming', (provider) => {
  it.each(['Please repair login', ''])(
    'keeps the first real input eligible after compact: %j',
    async (input) => {
      const { host, store, acquire, dispatch, log } = hostTestState()
      const compact = vi.fn<NonNullable<StructuredAgentSessionAdapter['compact']>>(async () => ({
        state: 'accepted',
        providerIdentity: null
      }))
      host.deps.adapter.compact = compact
      const handle =
        provider === 'claude'
          ? claudeProviderHandle(HOST_TEST_THREAD, null)
          : codexProviderHandle(HOST_TEST_THREAD)
      acquire.mockImplementation(async ({ fence, spawnToken }) => ({
        process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
        link: {
          linkId: `link-${fence}`,
          handle,
          origin: 'created',
          mintedAtFence: fence,
          observedAt: 100
        }
      }))
      dispatch.mockResolvedValue({ state: 'admitted' })
      const readFirstPrompt = vi.fn(async (sessionId: string, startedAt: number) =>
        firstStructuredChatNamingPrompt(await host.journalSnapshot(sessionId), startedAt)
      )
      const generate = vi.fn(async () => 'Saved first input')
      const naming = createStructuredChatNamingHandler({
        getStore: () => store,
        getSettings: () => ({}),
        hasOpenDispatch: () => false,
        readFirstPrompt,
        generate,
        onNamed: vi.fn(),
        logger: log.logger
      })
      const observer = vi.fn(naming)
      host.deps.onSessionStatusChanged = observer
      expect(
        await host.attach(
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
      ).toMatchObject({ ok: true })
      expect(
        await host.conversationCommand(
          { callerKey: 'client-1' },
          {
            command: 'compact',
            envelope: envelope('agentSession.conversationCommand', { command: 'compact' })
          }
        )
      ).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1))
      expect(
        observer.mock.calls.some(
          ([summary, options]) =>
            summary.status === 'working' && options.firstInputSubmissionKey === null
        )
      ).toBe(true)
      const events = acquire.mock.calls.at(-1)?.[0].events
      const command = compact.mock.calls[0]?.[0].command
      if (!events || !command) {
        throw new Error('Missing actual compact turn')
      }
      for (let index = 0; index < 12; index++) {
        events.publish()
      }
      await host.flushStreamedEvents(HOST_TEST_SESSION)
      expect(readFirstPrompt).not.toHaveBeenCalled()
      events.appendLifecycleBatch?.(
        'compact-finished',
        [
          {
            kind: 'item',
            identity: command.identity,
            body: {
              ...command.running,
              state: 'completed',
              outcome: 'success',
              completedAt: Date.now()
            },
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        ],
        { lifecycle: true }
      )
      await host.flushStreamedEvents(HOST_TEST_SESSION)
      const body = hostTestMessage(input)
      expect(
        await host.send(
          { callerKey: 'client-1' },
          { body, envelope: envelope('agentSession.send', { body }) }
        )
      ).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(readFirstPrompt).toHaveBeenCalledTimes(1))
      if (input) {
        await vi.waitFor(() =>
          expect(store.getRecord(HOST_TEST_SESSION)?.conversationName).toBe('Saved first input')
        )
        expect(generate).toHaveBeenCalledExactlyOnceWith(expect.anything(), input)
      } else {
        expect(generate).not.toHaveBeenCalled()
      }
      for (let index = 0; index < 12; index++) {
        events.publish()
      }
      const later = hostTestMessage('Later input must not rename')
      await host.send(
        { callerKey: 'client-1' },
        { body: later, envelope: envelope('agentSession.send', { body: later }) }
      )
      await host.flushStreamedEvents(HOST_TEST_SESSION)
      expect(readFirstPrompt).toHaveBeenCalledTimes(1)
      expect(generate).toHaveBeenCalledTimes(input ? 1 : 0)
    }
  )
})
