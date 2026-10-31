import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { currentMessageQuestionView } from '../../../shared/agent-session-current-requests'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { failQuestionSettlement } from '../message-question-settlement-failure.test-fixture'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { observeAsyncQuestions } from './structured-agent-session-question-observation.test-fixture'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams
} from './structured-agent-session-host-test-data'

describe('qualified clipped factual imports after current membership removal', () => {
  let root: string | undefined
  let host: StructuredAgentSessionHost | undefined
  let closeReader: (() => void) | undefined
  let restoreStorage: (() => void) | undefined

  afterEach(async () => {
    const errors: unknown[] = []
    for (const close of [
      closeReader,
      restoreStorage,
      () => host?.flushAllStreamedEvents(),
      () => root && closeTestJournalHostDatabase(root),
      () => root && rm(root, { recursive: true, force: true })
    ]) {
      try {
        await close?.()
      } catch (error) {
        errors.push(error)
      }
    }
    closeReader = undefined
    restoreStorage = undefined
    host = undefined
    root = undefined
    if (errors.length) {
      throw new AggregateError(errors, 'clipped original fixture cleanup failed')
    }
  })

  it.each(['epoch', 'context'] as const)(
    'restores historical single/mixed calls through %s, repeat and cold without reviving rows',
    async (replacement) => {
      root = await mkdtemp(join(tmpdir(), 'orca-clipped-original-replay-'))
      const profile = root
      const home = join(profile, 'account')
      await mkdir(join(home, 'sessions'), { recursive: true })
      const path = join(home, 'sessions', `rollout-2026-09-06T18-00-00-${THREAD}.jsonl`)
      const large = 'full retained definition α🙂 '.repeat(1000)
      const input = (title: string, label: string) => ({
        questions: [{ title, options: [label, 'other'] }]
      })
      const lines = [
        { type: 'session_meta', payload: { id: THREAD, cwd: profile } },
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'request_user_input_async',
            call_id: 'single',
            arguments: JSON.stringify(input('single', large))
          }
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'shell', input: { command: 'pwd' } },
              {
                type: 'tool_use',
                name: 'request_user_input_async',
                input: input('mixed large', large)
              },
              {
                type: 'tool_use',
                name: 'request_user_input_async',
                input: input('mixed small', 'small')
              }
            ]
          }
        },
        {
          type: 'event_msg',
          timestamp: new Date(NOW).toISOString(),
          payload: { type: 'user_message', message: 'actual direct-terminal answer α🙂' }
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'current anchor' }]
          }
        }
      ]
      await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
      let store = await openTestAgentSessionRecordStore(profile)
      const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>(async () => {
        throw new Error('At-rest original proof must not acquire')
      })
      const adapter: StructuredAgentSessionAdapter = {
        open: async () => ({ reportedOptions: { model: '' } }),
        acquire,
        dispatch: vi.fn(),
        cancelTurn: vi.fn(),
        answerPrompt: vi.fn(),
        setOption: vi.fn()
      }
      const makeHost = () =>
        new StructuredAgentSessionHost({
          agents: NO_STRUCTURED_AGENTS,
          store,
          adapter,
          logger: createStructuredAgentSessionLogger(),
          journalDatabase: openTestJournalHostDatabase(profile),
          claimKeyId: 'key-1',
          resolveWorkspacePath: async () => profile,
          now: () => NOW
        })
      host = makeHost()
      const fault = failQuestionSettlement(
        openTestJournalHostDatabase(profile).db,
        'no-existing-occurrence',
        'q2'
      )
      restoreStorage = fault.restore
      expect(
        await host.create(
          { callerKey: 'client-1' },
          hostTestAttachParams(null, {
            accountHome: { variable: 'CODEX_HOME', path: home },
            adopt: { providerHandle: codexProviderHandle(THREAD), transcriptPath: path }
          })
        )
      ).toMatchObject({ ok: true })
      await host.history({ sessionId: SESSION, direction: 'tail' })
      let journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
      const identities = [1, 2, 3].map((index) => ({
        provider: 'legacy' as const,
        agent: 'codex' as const,
        sessionId: THREAD,
        recordId: `#${index}`
      }))
      const [single, mixed, answer] = identities.map(agentJournalItemKey)
      expect(journal.item(single)?.body).toMatchObject({
        kind: 'tool-call',
        input: { truncated: true }
      })
      expect(
        journal
          .questionSourceFacts()
          .inputs.filter(
            (entry) => entry.kind === 'item' && [single, mixed].includes(entry.item.itemId)
          )
          .map((entry) => entry.kind === 'item' && entry.fence)
      ).toEqual([0, 0])
      const observed = await observeAsyncQuestions({ host }, 'before-removal')
      closeReader = observed.close
      await vi.waitFor(() => expect(observed.state().requestAuthority).toBeDefined())
      await vi.waitFor(() => expect(fault.rejectedInserts()).toBeGreaterThan(0), {
        timeout: 10_000
      })
      expect(currentMessageQuestionView(observed.state())?.ready).not.toBe(true)
      observed.close()
      closeReader = undefined
      expect(
        journal.messageQuestions().repository.current(journal.messageQuestions().source).records
      ).toEqual([])
      await rename(path, `${path}.held`)
      const fence = store.getRecord(SESSION)!.lease.runtimeFence
      if (replacement === 'context') {
        for (const identity of identities) {
          await journal.appendTombstone(identity, { fence })
        }
        await journal.context.clear(
          { operationId: 'clipped-context', afterFence: fence, clearedAt: NOW },
          { write: () => {}, committed: () => {} }
        )
      }
      const replace = async () => {
        await (replacement === 'context'
          ? journal.context.rewind(journal.context.floor()!, fence, [], () => ({
              write: () => {},
              committed: () => {}
            }))
          : journal.replaceEpochItems(
              'handle_forked',
              fence,
              journal
                .snapshot()
                .items.filter((item) => ![single, mixed, answer].includes(item.itemId))
                .map((item) => ({
                  identity: parseAgentJournalItemKey(item.itemId)!,
                  body: item.body,
                  observedAt: item.observedAt,
                  ownerFence: journal.itemFence(item.itemId)!,
                  turnScope: item.turnScope
                }))
            ))
      }
      const cold = async () => {
        restoreStorage?.()
        restoreStorage = undefined
        await host!.flushAllStreamedEvents()
        closeTestJournalHostDatabase(profile)
        store = await openTestAgentSessionRecordStore(profile)
        host = makeHost()
        await host.history({ sessionId: SESSION, direction: 'tail' })
        journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
      }
      for (let pass = 0; pass < 2; pass++) {
        await replace()
        await cold()
        expect([single, mixed, answer].map((id) => journal.item(id))).toEqual([null, null, null])
        expect(
          journal
            .questionSourceFacts()
            .inputs.filter(
              (entry) => entry.kind === 'item' && [single, mixed].includes(entry.item.itemId)
            )
            .map((entry) => entry.kind === 'item' && entry.fence)
        ).toEqual([0, 0])
      }
      // The other destructive owner must preserve the same original dependencies too.
      await journal.replaceEpochItems('handle_forked', fence, [])
      await cold()
      const currentIds = journal.snapshot().items.map((item) => item.itemId)
      const recovery = await observeAsyncQuestions({ host: host! }, 'historical-original-recovery')
      closeReader = recovery.close
      await vi.waitFor(() => expect(recovery.state().requestAuthority).toBeDefined())
      expect(currentMessageQuestionView(recovery.state())?.ready).not.toBe(true)
      expect(
        journal.messageQuestions().repository.current(journal.messageQuestions().source).records
      ).toEqual([])
      // Restore only the registered original source; the actual reader/backoff owns recovery.
      await rename(`${path}.held`, path)
      await vi.waitFor(
        () => expect(currentMessageQuestionView(recovery.state())?.ready).toBe(true),
        { timeout: 10_000 }
      )
      const records = journal
        .messageQuestions()
        .repository.current(journal.messageQuestions().source).records
      expect(
        records.map((record) => [
          record.sourceRowId,
          record.callSlot,
          record.questions[0].question,
          record.timestamp,
          record.resolution
        ])
      ).toEqual([
        [
          single,
          0,
          'single',
          null,
          {
            state: 'resolved',
            reason: 'delivery',
            resolvedAt: NOW,
            resolvedBy: null,
            factId: answer
          }
        ],
        [
          mixed,
          0,
          'mixed large',
          null,
          {
            state: 'resolved',
            reason: 'delivery',
            resolvedAt: NOW,
            resolvedBy: null,
            factId: answer
          }
        ],
        [
          mixed,
          1,
          'mixed small',
          null,
          {
            state: 'resolved',
            reason: 'delivery',
            resolvedAt: NOW,
            resolvedBy: null,
            factId: answer
          }
        ]
      ])
      expect(records.slice(0, 2).map((record) => record.questions[0].options[0].label)).toEqual([
        large,
        large
      ])
      expect(recovery.state().asyncQuestions).toEqual([])
      expect(journal.snapshot().items.map((item) => item.itemId)).toEqual(currentIds)
      expect(journal.submissions()).toEqual([])
      expect(acquire).not.toHaveBeenCalled()
      expect(adapter.dispatch).not.toHaveBeenCalled()
      recovery.close()
      closeReader = undefined
      await cold()
      const final = await observeAsyncQuestions({ host: host! }, 'historical-original-final-cold')
      closeReader = final.close
      await vi.waitFor(() => expect(currentMessageQuestionView(final.state())?.ready).toBe(true), {
        timeout: 10_000
      })
      expect(
        journal.messageQuestions().repository.current(journal.messageQuestions().source).records
      ).toEqual(records)
      expect(journal.snapshot().items.map((item) => item.itemId)).toEqual(currentIds)
    }
  )
})
