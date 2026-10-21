import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

const SESSION = 'codex-questions'
const journals = createTrackedJournalOpener()
let root: string | undefined

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  ['repeated', ['pick', 'pick'], ['Question 1?']],
  ['distinct', ['a', 'b'], ['Question 0?', 'Question 1?']]
] as const)(
  'shows %s question ids through the queued sink without a host fault',
  async (_name, ids, questions) => {
    root = await mkdtemp(join(tmpdir(), 'orca-codex-questions-'))
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'folder',
        hostId: 'host',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread')
      },
      stateDirectory: root,
      now: () => 1_000
    })
    const onFailed = vi.fn()
    const published: ReturnType<typeof journal.snapshot>[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink({
      ...testEventSinkLogging(SESSION),
      onFailed
    })
    deferred.bind({
      journal,
      fence: 7,
      publish: () => {
        published.push(journal.snapshot())
      }
    })
    const translator = createCodexJournalTranslator({
      sink: deferred.sink,
      primaryThreadId: () => 'thread',
      now: () => 900
    })
    expect(
      translator.handle({
        type: 'notification',
        sessionId: SESSION,
        threadId: 'thread',
        method: 'turn/started',
        params: { turn: { id: 'turn' } }
      })
    ).toEqual({ accepted: true })
    expect(
      translator.handle({
        type: 'prompt',
        sessionId: SESSION,
        threadId: 'thread',
        method: 'item/tool/requestUserInput',
        params: {
          turnId: 'turn',
          questions: ids.map((id, index) => ({ id, question: `Question ${index}?` }))
        },
        codexItemId: 'ask-1',
        promptKey: 'ask-1'
      })
    ).toEqual({ accepted: true })
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    expect(onFailed).not.toHaveBeenCalled()
    expect(deferred.state().failed).toBe(false)
    const saved = journal.snapshot().items.filter((item) => item.body.kind === 'question')
    expect(
      saved.map((item) => (item.body.kind === 'question' ? item.body.question : null))
    ).toEqual(questions)
    expect(saved.map((item) => item.revision)).toEqual(ids[0] === ids[1] ? [2] : [1, 1])
    expect(published.at(-1)).toEqual(journal.snapshot())
    translator.dispose()
    deferred.close()
  }
)
