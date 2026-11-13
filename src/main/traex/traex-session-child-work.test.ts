import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { TraexSessionAdapter } from './traex-session-adapter'
import { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import type { AgentChildWorkEvidence } from '../../shared/agent-status/child-work/agent-status-child-work-evidence'

it('keeps nested child activity out of root turns and stops only the named child work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-trae-child-work-'))
  const identity = {
    sessionId: 'trae-children',
    workspaceId: 'folder-contract',
    hostId: 'local',
    agent: 'trae' as const,
    providerHandle: null
  }
  const journal = new AgentSessionJournal({
    identity,
    database: openTestJournalHostDatabase(directory)
  })
  await journal.open()
  const { logger } = recordingStructuredAgentSessionLogger()
  const sink = createDeferredStructuredAgentSessionEventSink({
    sessionId: identity.sessionId,
    logger
  })
  sink.bind({ journal, fence: 1, publish: () => {} })
  const evidence: AgentChildWorkEvidence[] = []
  const adapter = new TraexSessionAdapter({
    resolveLaunch: async () => ({
      command: process.execPath,
      args: [join(import.meta.dirname, '__fixtures__', 'traex-scripted-app-server.mjs')],
      cwd: directory,
      previousThreadId: null,
      mayBeUnsaved: false,
      options: {},
      permissionMode: 'ask',
      env: {},
      envToDelete: []
    }),
    onLifecycle: () => {},
    onSettled: () => {},
    onChildWorkEvidence: (_sessionId, events) => evidence.push(...events)
  })
  try {
    const acquisition = await adapter.acquire({
      identity,
      fence: 1,
      spawnToken: randomUUID(),
      events: sink.sink
    })
    await adapter.open({
      sessionId: identity.sessionId,
      fence: 1,
      acquisitionGeneration: acquisition.acquisitionGeneration,
      signal: new AbortController().signal
    })
    await adapter.dispatch({
      sessionId: identity.sessionId,
      fence: 1,
      clientMessageId: 'child-work-input',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'child-work' }] }
    })
    const messages = () =>
      journal.currentRead().items.filter((item) => item.body.kind === 'message')
    await expect
      .poll(() =>
        messages().some((item) => JSON.stringify(item.body).includes('ROOT_CONTRACT_DONE'))
      )
      .toBe(true)
    const child = messages().find(
      (item) =>
        JSON.stringify(item.body).includes('CHILD_CONTRACT_TEXT') &&
        !JSON.stringify(item.body).includes('GRANDCHILD')
    )!
    const grandchild = messages().find((item) =>
      JSON.stringify(item.body).includes('GRANDCHILD_CONTRACT_TEXT')
    )!
    expect(child.agentId).toBe('child-contract')
    expect(grandchild.agentId).toBe('grandchild-contract')
    expect(grandchild.parentAgentId).toBe('child-contract')
    expect(
      journal
        .currentRead()
        .items.find((item) => item.body.kind === 'tool-call' && item.body.name === 'spawn_agent')
        ?.body
    ).toMatchObject({ input: { agents: ['child-contract'] } })
    expect(messages().some((item) => JSON.stringify(item.body).includes('STRAY_TEXT'))).toBe(false)
    expect(
      journal
        .currentRead()
        .items.filter((item) => item.body.kind === 'turn')
        .map((item) => (item.body.kind === 'turn' ? item.body.state : null))
    ).toEqual(['completed'])
    await expect
      .poll(() =>
        evidence.some(
          (event) =>
            event.type === 'live' &&
            event.child.handle.id === 'child-contract' &&
            event.child.totalTokens === 42
        )
      )
      .toBe(true)
    const acknowledgements: string[] = []
    expect(
      await adapter.stopBackgroundTasks({
        sessionId: identity.sessionId,
        fence: 1,
        taskIds: ['child-contract'],
        acknowledge: (ack) => acknowledgements.push(ack.taskId)
      })
    ).toEqual({ cancelled: true })
    expect(acknowledgements).toEqual(['child-contract', 'grandchild-contract'])
    await expect
      .poll(() =>
        evidence.some(
          (event) =>
            event.type === 'ended' &&
            event.handle.id === 'child-contract' &&
            event.outcome === 'cancelled'
        )
      )
      .toBe(true)
    await expect
      .poll(() =>
        evidence.some(
          (event) =>
            event.type === 'live' &&
            event.child.kind === 'command' &&
            event.child.residency === 'background' &&
            event.child.stoppable
        )
      )
      .toBe(true)
    expect(
      await adapter.stopBackgroundTasks({
        sessionId: identity.sessionId,
        fence: 1,
        taskIds: ['traex-command:["thread-trae-contract","turn-1","command-child-work"]']
      })
    ).toEqual({ cancelled: true })
  } finally {
    await adapter.closeAll()
    await journal.close()
    await closeTestJournalHostDatabases()
    await rm(directory, { recursive: true, force: true })
  }
})

it('projects plans, measured context, rich messages and native approval callbacks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-trae-child-work-'))
  const identity = {
    sessionId: 'trae-children',
    workspaceId: 'folder-contract',
    hostId: 'local',
    agent: 'trae' as const,
    providerHandle: null
  }
  const journal = new AgentSessionJournal({
    identity,
    database: openTestJournalHostDatabase(directory)
  })
  await journal.open()
  const { logger } = recordingStructuredAgentSessionLogger()
  const sink = createDeferredStructuredAgentSessionEventSink({
    sessionId: identity.sessionId,
    logger
  })
  sink.bind({ journal, fence: 1, publish: () => {} })
  const evidence: AgentChildWorkEvidence[] = []
  const adapter = new TraexSessionAdapter({
    resolveLaunch: async () => ({
      command: process.execPath,
      args: [join(import.meta.dirname, '__fixtures__', 'traex-scripted-app-server.mjs')],
      cwd: directory,
      previousThreadId: null,
      mayBeUnsaved: false,
      options: {},
      permissionMode: 'ask',
      env: {},
      envToDelete: []
    }),
    onLifecycle: () => {},
    onSettled: () => {},
    onChildWorkEvidence: (_sessionId, events) => evidence.push(...events)
  })
  try {
    const acquisition = await adapter.acquire({
      identity,
      fence: 1,
      spawnToken: randomUUID(),
      events: sink.sink
    })
    await adapter.open({
      sessionId: identity.sessionId,
      fence: 1,
      acquisitionGeneration: acquisition.acquisitionGeneration,
      signal: new AbortController().signal
    })
    await adapter.setOption({
      sessionId: identity.sessionId,
      fence: 1,
      key: 'interactionMode',
      value: 'plan'
    })
    await adapter.dispatch({
      sessionId: identity.sessionId,
      fence: 1,
      clientMessageId: 'audit-input',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'parity-audit' }] }
    })
    const rows = () => journal.currentRead().items
    await expect.poll(() => rows().some((row) => row.body.kind === 'approval')).toBe(true)
    expect(
      rows().find((row) => row.body.kind === 'tool-call' && row.body.name === 'update_plan')?.body
    ).toMatchObject({
      input: {
        plan: [
          { step: 'Inspect', status: 'completed' },
          { step: 'Implement', status: 'inProgress' }
        ]
      }
    })
    expect(rows().find((row) => row.body.kind === 'turn')?.body).toMatchObject({
      contextUsage: {
        used: {
          kind: 'report',
          usedTokens: 512,
          windowTokens: 1000,
          percentage: 51,
          capturedAt: 100000,
          categories: [{ tokens: 300 }, { tokens: 212 }]
        }
      }
    })
    expect(
      rows().find(
        (row) =>
          row.body.kind === 'message' && row.body.blocks.some((block) => block.type === 'image-ref')
      )?.body
    ).toMatchObject({
      blocks: [{ type: 'text' }, { type: 'image-ref', path: '/tmp/view-audit.png' }]
    })
    expect(
      rows().find((row) => row.body.kind === 'tool-call' && row.body.name === 'web_search')?.body
    ).toMatchObject({ webSearchResults: [{ title: 'Example', url: 'https://example.com' }] })
    expect(
      rows().find(
        (row) =>
          row.body.kind === 'message' &&
          row.body.blocks.some(
            (block) => block.type === 'tool-call' && block.name === 'request_user_input_async'
          )
      )?.body
    ).toMatchObject({
      blocks: [
        { type: 'text' },
        { type: 'tool-call', input: { questions: [{ title: 'Route?', options: ['A', 'B'] }] } }
      ]
    })
    const mode = rows().find((row) => row.body.kind === 'approval')!
    const commit = async () => {}
    await adapter.answerPrompt({
      sessionId: identity.sessionId,
      fence: 1,
      itemId: mode.itemId,
      kind: 'approval',
      response: { kind: 'option', optionId: 'accept' },
      commit
    })
    expect(await adapter.readOptions!({ sessionId: identity.sessionId, fence: 1 })).toMatchObject({
      current: { interactionMode: 'default', reportedModel: 'fallback-model' }
    })
    await expect
      .poll(() => rows().some((row) => row.body.kind === 'approval' && row.itemId !== mode.itemId))
      .toBe(true)
    const mcp = rows().find((row) => row.body.kind === 'approval' && row.itemId !== mode.itemId)!
    await adapter.answerPrompt({
      sessionId: identity.sessionId,
      fence: 1,
      itemId: mcp.itemId,
      kind: 'approval',
      response: { kind: 'option', optionId: 'acceptForSession' },
      commit
    })
    await expect
      .poll(() =>
        rows().some(
          (row) => row.body.kind === 'status' && row.body.failure?.kind === 'providerUnavailable'
        )
      )
      .toBe(true)
    expect(
      rows().filter(
        (row) => row.body.kind === 'status' && row.body.failure?.kind === 'providerUnavailable'
      )
    ).toHaveLength(1)
    expect(rows().some((row) => row.body.kind === 'question')).toBe(false)
    expect(
      rows().find(
        (row) =>
          row.body.kind === 'message' &&
          row.body.blocks.some(
            (block) =>
              block.type === 'tool-call' &&
              block.input &&
              typeof block.input === 'object' &&
              'questions' in block.input &&
              JSON.stringify(block.input).includes('Pick more than one')
          )
      )?.body
    ).toMatchObject({
      blocks: [
        { type: 'text' },
        { type: 'tool-call', input: { questions: [{ multiSelect: true }] } }
      ]
    })
  } finally {
    await adapter.closeAll()
    await journal.close()
    await closeTestJournalHostDatabases()
    await rm(directory, { recursive: true, force: true })
  }
})
