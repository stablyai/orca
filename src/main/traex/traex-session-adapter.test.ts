import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { TraexSessionAdapter } from './traex-session-adapter'
import { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { stopAgentSessionProviderRoot } from '../native-chat/agent-session-wire/termination/structured-agent-session-provider-exit-proof'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import { AgentSessionPromptUnavailableError } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { agentJournalTurnBody } from '../../shared/agent-session/lifecycle/agent-session-turn-record'

let directory: string | undefined
let adapter: TraexSessionAdapter | undefined
let journal: AgentSessionJournal | undefined

afterEach(async () => {
  await adapter?.closeAll()
  await journal?.close()
  await closeTestJournalHostDatabases()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

it('commits one answer to each prompt, rejects unknown callbacks, and interrupts the owned turn', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-trae-contract-'))
  const identity = {
    sessionId: 'trae-contract',
    workspaceId: 'folder-contract',
    hostId: 'local',
    agent: 'trae' as const,
    providerHandle: null
  }
  journal = new AgentSessionJournal({ identity, database: openTestJournalHostDatabase(directory) })
  await journal.open()
  const { logger } = recordingStructuredAgentSessionLogger()
  const sink = createDeferredStructuredAgentSessionEventSink({
    sessionId: identity.sessionId,
    logger
  })
  sink.bind({ journal, fence: 1, publish: () => {} })
  adapter = new TraexSessionAdapter({
    resolveLaunch: async () => ({
      command: process.execPath,
      args: [join(import.meta.dirname, '__fixtures__', 'traex-scripted-app-server.mjs')],
      cwd: directory!,
      previousThreadId: null,
      mayBeUnsaved: false,
      options: {},
      permissionMode: 'ask',
      env: {},
      envToDelete: []
    }),
    readProcessStartTime: async () => 1,
    onLifecycle: () => {},
    onSettled: () => {}
  })
  const acquired = await adapter.acquire({
    identity,
    fence: 1,
    spawnToken: randomUUID(),
    events: sink.sink
  })
  await adapter.open({
    sessionId: identity.sessionId,
    fence: 1,
    acquisitionGeneration: acquired.acquisitionGeneration,
    signal: new AbortController().signal
  })
  await adapter.setOption({
    sessionId: identity.sessionId,
    fence: 1,
    key: 'effort',
    value: 'medium'
  })
  const send = (text: string) =>
    adapter!.dispatch({
      sessionId: identity.sessionId,
      fence: 1,
      clientMessageId: randomUUID(),
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
    })
  const rows = () => journal!.currentRead().items
  expect((await send('approval-and-question')).state).toBe('accepted')
  await expect.poll(() => rows().some((row) => row.body.kind === 'approval')).toBe(true)
  const approval = rows().find((row) => row.body.kind === 'approval')!
  const commit = () =>
    journal!
      .appendItem(
        {
          provider: 'legacy',
          agent: 'trae',
          sessionId: identity.sessionId,
          recordId: 'answer-commit'
        },
        { kind: 'status', text: 'Answer committed' },
        { fence: 1, turnScope: { kind: 'thread' } }
      )
      .then(() => {})
  const answering = adapter.answerPrompt({
    sessionId: identity.sessionId,
    fence: 1,
    itemId: approval.itemId,
    kind: 'approval',
    response: { kind: 'option', optionId: 'accept' },
    commit
  })
  await expect(
    adapter.answerPrompt({
      sessionId: identity.sessionId,
      fence: 1,
      itemId: approval.itemId,
      kind: 'approval',
      response: { kind: 'option', optionId: 'accept' },
      commit
    })
  ).rejects.toBeInstanceOf(AgentSessionPromptUnavailableError)
  await answering
  await expect.poll(() => rows().some((row) => row.body.kind === 'question')).toBe(true)
  const question = rows().find((row) => row.body.kind === 'question')!
  await adapter.answerPrompt({
    sessionId: identity.sessionId,
    fence: 1,
    itemId: question.itemId,
    kind: 'question',
    response: {
      kind: 'answers',
      answers: [
        { questionId: 'color', optionIds: ['0'] },
        { questionId: 'name', optionIds: [], other: 'Orca' }
      ]
    },
    commit
  })
  const answerText = () =>
    rows()
      .flatMap((row) =>
        row.body.kind === 'message' && row.body.role === 'assistant'
          ? row.body.blocks.flatMap((block) => (block.type === 'text' ? block.text : []))
          : []
      )
      .join('\n')
  await expect.poll(answerText).toBe('Blue:Orca')
  await expect.poll(() => journal!.newestTurn()?.state).toBe('completed')
  expect((await send('unknown-request')).state).toBe('accepted')
  await expect.poll(answerText).toBe('Blue:Orca\nunrecognized request rejected')
  await expect.poll(() => journal!.newestTurn()?.state).toBe('completed')
  expect((await send('wait-for-interrupt')).state).toBe('accepted')
  expect((await adapter.cancelTurn({ sessionId: identity.sessionId, fence: 1 })).cancelled).toBe(
    true
  )
  await expect.poll(() => journal!.newestTurn()?.state).toBe('interrupted')
  const commandIdentity = {
    provider: 'legacy' as const,
    agent: 'trae' as const,
    sessionId: identity.sessionId,
    recordId: 'compact-command'
  }
  const running = agentJournalTurnBody({ turnId: 'compact-command', state: 'running' })
  await journal.appendItem(commandIdentity, running, { fence: 1, turnScope: { kind: 'thread' } })
  await adapter.compact({
    sessionId: identity.sessionId,
    fence: 1,
    command: {
      clientMessageId: 'compact-input',
      turnId: 'compact-command',
      identity: commandIdentity,
      resultIdentity: commandIdentity,
      running
    }
  })
  await expect.poll(() => journal!.newestTurn()?.state).toBe('completed')
  expect(
    rows().some((row) => row.body.kind === 'status' && row.body.presentation === 'compaction')
  ).toBe(true)
  const failedIdentity = { ...commandIdentity, recordId: 'failed-compact-command' }
  const failedRunning = agentJournalTurnBody({ turnId: 'failed-compact-command', state: 'running' })
  await journal.appendItem(failedIdentity, failedRunning, {
    fence: 1,
    turnScope: { kind: 'thread' }
  })
  await adapter.compact({
    sessionId: identity.sessionId,
    fence: 1,
    command: {
      clientMessageId: 'failed-compact-input',
      turnId: 'failed-compact-command',
      identity: failedIdentity,
      resultIdentity: failedIdentity,
      running: failedRunning,
      instructions: 'fail-compaction'
    }
  })
  await expect
    .poll(() =>
      rows().some(
        (row) => row.body.kind === 'status' && row.body.failure?.kind === 'usageLimitReached'
      )
    )
    .toBe(true)
  await stopAgentSessionProviderRoot(() => adapter!.closeSession(identity.sessionId))
  expect(adapter.holdsLiveProviderProcess(identity.sessionId, acquired.acquisitionGeneration)).toBe(
    false
  )
})
