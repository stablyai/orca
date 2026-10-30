import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

import {
  RUNNING_IDENTITY,
  THREAD,
  journalWith,
  promptItem,
  turnScopeOf
} from './structured-agent-session-stale-verdict-contract-test-fixture'

it('cancels only prompts whose callbacks were lost with the prior owner', async () => {
  const pending = promptItem('pending', 1)
  const resolved = promptItem('resolved', 2)
  const { journal, appendLifecycleBatch } = journalWith([pending, resolved])

  await expect(
    settleStaleStructuredAgentSessionState({
      journal,
      sessionId: 'session-1',
      fence: 14,
      acquisitionGeneration: 'generation-2',
      deathEvidence: null
    })
  ).resolves.toBe(1)

  expect(appendLifecycleBatch).toHaveBeenCalledExactlyOnceWith({
    settlementId: 'stale-session:session-1:14:generation-2',
    fence: 14,
    recovered: true,
    dispatches: [],
    mutations: [
      {
        kind: 'item',
        itemId: pending.itemId,
        body: {
          ...pending.body,
          resolution: {
            state: 'cancelled',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        },
        turnScope: { kind: 'thread' }
      }
    ]
  })
})

it("cancels a subagent's lost prompt as the subagent's, and the session's own as its own", async () => {
  // Producer-free cancellation revisions must retain original attribution.
  const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
  const journals = createTrackedJournalOpener({ legacyInputs: true })
  try {
    const journal = await journals.open({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle(THREAD)
      },
      stateDirectory: root,
      now: () => 1_000
    })
    const child = { agentId: 'thread-child', producerKind: 'agent' as const }
    const { body } = promptItem('pending', 1)
    const prompt = (threadId: string) => ({
      provider: 'codex' as const,
      threadId,
      turnId: 'turn-1',
      ordinal: 1
    })
    await journal.appendItem(prompt('thread-child'), body, {
      fence: 1,
      ...child,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.appendItem(prompt(THREAD), body, {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })

    await settleStaleStructuredAgentSessionState({
      journal,
      sessionId: 'session-1',
      fence: 2,
      acquisitionGeneration: 'generation-2',
      deathEvidence: null
    })

    expect(
      journal.snapshot().items.map((item) => [item.body.kind, item.revision, item.agentId])
    ).toEqual([
      ['approval', 2, 'thread-child'],
      ['approval', 2, undefined]
    ])
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})

it('uses provider output after a renewal, excluding a later client message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
  const journals = createTrackedJournalOpener({ legacyInputs: true })
  let now = 100
  try {
    const journal = await journals.open({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle(THREAD)
      },
      stateDirectory: root,
      now: () => now
    })
    const command = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
    const shell = { kind: 'tool-call' as const, name: 'shell', input: { command: 'pnpm test' } }
    const turnScope = turnScopeOf({ ...command, ordinal: 0 })
    await journal.appendItem(
      { ...command, ordinal: 0 },
      { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 100 },
      { fence: 1, turnScope }
    )
    now = 200
    await journal.appendItem(command, { ...shell, state: 'running' }, { fence: 1, turnScope })
    // Provider output can prove life after lease renewal.
    now = 700
    await journal.appendItem(
      command,
      { ...shell, input: { command: 'pnpm test', streamed: 'ok' }, state: 'running' },
      { fence: 1, turnScope }
    )
    now = 800
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'late-send' },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'next task' }] },
      { fence: 1, turnScope }
    )
    now = 9_000

    await settleStaleStructuredAgentSessionState({
      journal,
      sessionId: 'session-1',
      fence: 2,
      acquisitionGeneration: 'generation-2',
      deathEvidence: {
        kind: 'pid-absent',
        detail: 'recorded pid absent on host',
        observedAt: 9_000,
        ownerFence: 1,
        lastProvenAliveAt: 650
      }
    })

    const items = journal.snapshot().items
    expect(items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)).toMatchObject({
      state: 'interrupted',
      completedAt: 700
    })
    expect(items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))).toEqual([
      'The agent stopped while this response was in progress. You can continue in this conversation.'
    ])
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})

it('ends a crashed turn at its last proof of life, not at a send accepted before the proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
  const journals = createTrackedJournalOpener({ legacyInputs: true })
  let now = 100
  try {
    const journal = await journals.open({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle(THREAD)
      },
      stateDirectory: root,
      now: () => now
    })
    await journal.appendItem(
      RUNNING_IDENTITY,
      { kind: 'turn', turnId: 'turn-2', state: 'running', startedAt: 100 },
      { fence: 1, turnScope: turnScopeOf(RUNNING_IDENTITY) }
    )
    now = 200
    await journal.appendItem(
      { ...RUNNING_IDENTITY, ordinal: 1 },
      { kind: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'running' },
      { fence: 1, turnScope: turnScopeOf(RUNNING_IDENTITY) }
    )
    const settle = (deathEvidence: AgentSessionDeathEvidence | null) =>
      settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 1,
        acquisitionGeneration: null,
        deathEvidence
      })
    now = 3_600_000
    await settle(null)
    const turn = () => journal.snapshot().items.map((item) => readAgentJournalTurn(item.body))[0]
    expect(turn()).toMatchObject({ state: 'unverifiable' })
    now = 3_605_000
    await journal.appendSubmission({
      clientMessageId: 'send-1',
      payloadFingerprint: 'fingerprint-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'still there?' }] },
      fence: 1,
      handoverRecorded: true
    })
    await journal.resolveDispatch({
      clientMessageId: 'send-1',
      state: 'pending',
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      fence: 1
    })
    now = 3_606_000

    await settle({
      kind: 'pid-absent',
      detail: 'gone',
      observedAt: 3_606_000,
      ownerFence: 1,
      lastProvenAliveAt: 210
    })

    expect(turn()).toMatchObject({ state: 'interrupted', completedAt: 210 })
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})
