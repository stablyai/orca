import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { claudeStreamJsonExitError } from '../../claude/claude-stream-json-exit-error'
import { createClaudeJournalTranslator } from '../../claude/structured/journal/claude-structured-journal-translation'
import { withObservedProviderExit } from './structured-agent-session-failure-text'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  accept,
  acquire,
  eventually,
  host,
  publishFirst,
  registerStartupAttemptHostTests,
  restartWith,
  submission
} from './structured-agent-session-startup-attempt-host-test-support'

registerStartupAttemptHostTests()

it.each([false, true])(
  'publishes only the final startup failure (typed missing conversation: %s)',
  async (typed) => {
    const message = JSON.parse(
      readFileSync(
        new URL('../../claude/__fixtures__/claude-missing-conversation.jsonl', import.meta.url),
        'utf8'
      )
    )
    await restartWith(publishFirst)
    host.deps.adapter.open = async () => {
      const sink = host.collaboratorsForTests().runtimeState.currentEventSink(SESSION)!.sink
      createClaudeJournalTranslator({
        sink,
        fallbackIdPrefix: `attempt-${acquire.mock.calls.length}`
      }).handle({
        type: 'message',
        sessionId: SESSION,
        message,
        startupPending: true
      })
      throw withObservedProviderExit(
        typed
          ? claudeStreamJsonExitError(message.errors[0], {
              code: 1,
              signal: null,
              processless: false
            })
          : new Error(message.errors[0])
      )
    }
    const id = await accept('continue this chat')
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    expect(acquire).toHaveBeenCalledTimes(typed ? 1 : 5)
    const snapshot = await host.journalSnapshot(SESSION)
    const errors = snapshot.items.filter(
      (item) => item.body.kind === 'status' && item.body.tone === 'error'
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]?.body).toMatchObject({
      failure: { kind: typed ? 'savedConversationMissing' : 'providerStartFailed' }
    })
    if (typed) {
      expect(errors[0]?.body).toMatchObject({
        text: "Codex couldn't find this chat's saved conversation. Start a new chat to continue.",
        failure: { detail: { text: expect.stringContaining(message.errors[0]), audience: 'log' } }
      })
    }
  }
)
