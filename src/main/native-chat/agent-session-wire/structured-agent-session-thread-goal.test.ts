import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import {
  sweepAgentSessionAttachments,
  UNCLAIMED_ATTACHMENT_MAX_AGE_MS
} from '../agent-session-attachments/agent-session-attachment-sweep'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalThreadGoal,
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { markUnclaimedUploadForSweep } from '../agent-session-attachments/agent-session-attachment-claims'
import { formatNativeChatFileReference } from '../../../shared/agent-image-paste'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { performThreadGoalChange, threadGoalPlan } from './structured-agent-session-thread-goal'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

async function openJournal(onCommitted?: () => void): Promise<AgentSessionJournal> {
  root ??= await mkdtemp(join(tmpdir(), 'orca-thread-goal-'))
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  if (onCommitted) {
    journal.observeCommits(onCommitted)
  }
  return journal
}

const GOAL: AgentJournalThreadGoal = {
  objective: 'Ship the parser',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 1,
  timeUsedSeconds: 2,
  createdAt: 3_000,
  updatedAt: 4_000
}

function appendGoalRow(
  journal: AgentSessionJournal,
  overrides: Partial<AgentJournalThreadGoal>
): Promise<unknown> {
  return journal.appendItem(
    { provider: 'orca', clientMessageId: `goal-row:${journal.snapshot().items.length}` },
    { kind: 'status', text: 'Goal', threadGoal: { state: 'set', goal: { ...GOAL, ...overrides } } },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

function context(
  journal: AgentSessionJournal,
  double: Partial<StructuredAgentSessionAdapter>,
  agent = 'codex'
): AgentSessionTurnContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the goal path reads only the goal methods.
  const adapter = double as StructuredAgentSessionAdapter
  return {
    logger: createStructuredAgentSessionLogger(),
    sessionId: 'session-1',
    journal,
    fence: 1,
    adapter,
    agents: claudeAndCodexAgents(adapter),
    agent,
    persistOptions: async () => undefined,
    resolvedBy: 'client-1',
    publish: vi.fn(),
    now: () => 1
  }
}

describe('performThreadGoalChange', () => {
  it('journals the objective as a user message sent as a goal, durably', async () => {
    const journal = await openJournal()
    const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))

    const result = await performThreadGoalChange(
      context(journal, {
        changeThreadGoal
      }),
      { clientOperationId: 'op-1', change: { kind: 'set', objective: 'Ship the parser' } }
    )

    expect(result).toEqual({ ok: true, value: { change: 'set' } })
    expect(changeThreadGoal).toHaveBeenCalledWith({
      sessionId: 'session-1',
      fence: 1,
      change: { kind: 'set', objective: 'Ship the parser' },
      replacesGoal: false,
      executionOptions: {},
      signal: undefined
    })
    const expected = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Ship the parser' }],
      sentAs: 'goal'
    }
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([expected])

    await journal.close()
    const reopened = await openJournal()
    expect(reopened.snapshot().items.map((item) => item.body)).toEqual([expected])
  })

  it('removes the objective when the provider refuses the goal', async () => {
    const journal = await openJournal()
    const ctx = context(journal, {
      changeThreadGoal: async () => ({ ok: false, rejected: 'goals feature is disabled' })
    })

    const result = await performThreadGoalChange(ctx, {
      clientOperationId: 'op-2',
      change: { kind: 'set', objective: 'Ship the parser' }
    })

    expect(result).toEqual({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'providerRejected' },
        message: 'goals feature is disabled'
      }
    })
    expect(journal.snapshot().items).toEqual([])
  })

  it('retains the objective when a lost reply leaves application unknown', async () => {
    const journal = await openJournal()
    const ctx = context(journal, {
      changeThreadGoal: async () => {
        throw new Error('connection closed')
      }
    })

    await expect(
      performThreadGoalChange(ctx, {
        clientOperationId: 'op-3',
        change: { kind: 'set', objective: 'Ship the parser' }
      })
    ).rejects.toThrow('connection closed')
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      expect.objectContaining({ sentAs: 'goal' })
    ])
  })

  it('keeps a pasted file its objective names for the chat, and refuses one already swept', async () => {
    const journal = await openJournal()
    const storeRoot = agentSessionAttachmentStoreRoot(root ?? '')
    const kept = join(storeRoot, '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01', 'orca-paste-1-a.txt')
    await mkdir(dirname(kept), { recursive: true })
    await writeFile(kept, 'the spec')
    const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
    const ctx = context(journal, { changeThreadGoal })

    await performThreadGoalChange(ctx, {
      clientOperationId: 'op-6',
      change: { kind: 'set', objective: `Do ${formatNativeChatFileReference(kept)}` }
    })
    const db = openTestJournalHostDatabase(root ?? '').db
    expect(markUnclaimedUploadForSweep(db, '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01', 1)).toBe(false)

    const gone = join(storeRoot, '7c2d9e10-3f4a-4b5c-8d6e-2f1a0b9c8d02', 'orca-paste-2-b.txt')
    const result = await performThreadGoalChange(ctx, {
      clientOperationId: 'op-7',
      change: { kind: 'set', objective: `Do ${formatNativeChatFileReference(gone)}` }
    })
    expect(result).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'attachmentExpired' } }
    })
    expect(changeThreadGoal).toHaveBeenCalledTimes(1)
    expect(journal.snapshot().items).toHaveLength(1)
  })

  it('journals nothing for a status change or clear', async () => {
    const journal = await openJournal()
    const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
    const ctx = context(journal, {
      changeThreadGoal
    })

    await performThreadGoalChange(ctx, {
      clientOperationId: 'op-3',
      change: { kind: 'status', status: 'paused' }
    })
    await performThreadGoalChange(ctx, { clientOperationId: 'op-4', change: { kind: 'clear' } })

    expect(changeThreadGoal).toHaveBeenCalledTimes(2)
    expect(journal.snapshot().items).toEqual([])
  })

  it('refuses a session whose provider has no goals, without touching the journal', async () => {
    const journal = await openJournal()
    const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))

    const result = await performThreadGoalChange(context(journal, { changeThreadGoal }, 'claude'), {
      clientOperationId: 'op-5',
      change: { kind: 'set', objective: 'Ship it' }
    })

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(changeThreadGoal).not.toHaveBeenCalled()
    expect(journal.snapshot().items).toEqual([])
  })

  it('reports the latest goal the whole journal records', async () => {
    const journal = await openJournal()
    expect(journal.threadGoal()).toBeNull()
    await appendGoalRow(journal, { status: 'paused' })
    expect(journal.threadGoal()).toEqual({ ...GOAL, status: 'paused' })
  })

  it('tells the adapter a set replaces the goal the journal records, whatever its status', async () => {
    const journal = await openJournal()
    await appendGoalRow(journal, { status: 'complete' })
    const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
    const ctx = context(journal, {
      changeThreadGoal
    })

    await performThreadGoalChange(ctx, {
      clientOperationId: 'op-6',
      change: { kind: 'set', objective: 'Ship the tests' }
    })
    await performThreadGoalChange(ctx, {
      clientOperationId: 'op-7',
      change: { kind: 'status', status: 'paused' }
    })

    expect(changeThreadGoal.mock.calls).toEqual([
      [
        expect.objectContaining({
          change: { kind: 'set', objective: 'Ship the tests' },
          replacesGoal: true
        })
      ],
      [
        expect.objectContaining({
          change: { kind: 'status', status: 'paused' },
          replacesGoal: false
        })
      ]
    ])
  })

  it('reads a goal the provider reported, still landing when the set arrives, as the one it replaces', async () => {
    const journal = await openJournal()
    const changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
    const ctx = context(journal, {
      changeThreadGoal
    })

    // Issue without awaiting: the goal read must queue behind this write.
    const landing = appendGoalRow(journal, { status: 'active' })
    await performThreadGoalChange(ctx, {
      clientOperationId: 'op-10',
      change: { kind: 'set', objective: 'Ship the tests' }
    })

    await landing
    expect(changeThreadGoal).toHaveBeenCalledWith(expect.objectContaining({ replacesGoal: true }))
  })
})

describe('threadGoalPlan replay', () => {
  const envelope = {
    sessionId: 'session-1',
    clientOperationId: 'op-8',
    expectedRuntimeFence: 1,
    payloadFingerprint: 'fp'
  }

  it('replays only recorded success, never rerunning an unknown operation over a later decision', async () => {
    const journal = await openJournal()
    const ctx = context(journal, {})
    const plan = threadGoalPlan({ envelope, change: { kind: 'set', objective: GOAL.objective } })
    await appendGoalRow(journal, {})
    expect(plan.replay(ctx, { status: 'unknown' })).toBeNull()
    await appendGoalRow(journal, { status: 'paused' })
    expect(plan.replay(ctx, { status: 'unknown' })).toBeNull()
    expect(plan.rerunWhenReplayMissing?.(ctx)).not.toBe(true)
    expect(plan.recoverUnknownFromDurableState).not.toBe(true)
    expect(plan.replay(ctx, { status: 'succeeded', sessionId: 'session-1' })).toEqual({
      change: 'set'
    })
  })
})

async function storedGoalFile() {
  const uploadId = randomUUID()
  const path = join(agentSessionAttachmentStoreRoot(root ?? ''), uploadId, 'spec.txt')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'x'.repeat(100 * 1024))
  return {
    uploadId,
    path,
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: formatNativeChatFileReference(path) }]
    }
  }
}

it.each([1, 10])(
  'retires %i refused objectives through real mutation, reopen and sweep, preserving retry',
  async (count) => {
    let journal = await openJournal()
    const files = await Promise.all(Array.from({ length: count }, storedGoalFile))
    const rejected = vi.fn(async () => ({
      ok: false as const,
      rejected: 'goals feature is disabled'
    }))
    const db = openTestJournalHostDatabase(root ?? '').db
    const insertion = vi.spyOn(
      db.prepare(
        'INSERT OR IGNORE INTO agent_session_attachment_claims (upload_id, session_id, claimed_at) VALUES (?, ?, ?)'
      ),
      'run'
    )
    const retirement = vi.spyOn(
      db.prepare(
        'DELETE FROM agent_session_attachment_claims WHERE upload_id = ? AND session_id = ?'
      ),
      'run'
    )
    for (const file of files) {
      expect(
        await performThreadGoalChange(context(journal, { changeThreadGoal: rejected }), {
          clientOperationId: randomUUID(),
          change: { kind: 'set', objective: formatNativeChatFileReference(file.path) }
        })
      ).toMatchObject({ ok: false })
    }
    expect(insertion).toHaveBeenCalledTimes(count)
    expect(retirement).toHaveBeenCalledTimes(count)
    insertion.mockRestore()
    retirement.mockRestore()
    expect(journal.snapshot().items).toEqual([])
    expect(db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()).toHaveLength(
      0
    )
    // Retained retry source is still readable; a fresh user attempt can protect it.
    await performThreadGoalChange(
      context(journal, { changeThreadGoal: async () => ({ ok: true }) }),
      {
        clientOperationId: randomUUID(),
        change: { kind: 'set', objective: formatNativeChatFileReference(files[0]!.path) }
      }
    )
    await journal.close()
    closeTestJournalHostDatabase(root ?? '')
    journal = await openJournal()
    const reopened = openTestJournalHostDatabase(root ?? '').db
    const store = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(root ?? ''), {
      hasSession: () => true
    })
    const uploadModifiedAt = await Promise.all(
      files.map(async ({ path }) => (await stat(dirname(path))).mtimeMs)
    )
    const swept = await sweepAgentSessionAttachments(
      store,
      { database: () => reopened, recordedSessionIds: () => new Set([IDENTITY.sessionId]) },
      Math.max(...uploadModifiedAt) + UNCLAIMED_ATTACHMENT_MAX_AGE_MS + 1000
    )
    expect(swept.removed).toHaveLength(count - 1)
    expect(await readFile(files[0]!.path, 'utf8')).toHaveLength(100 * 1024)
    expect(journal.snapshot().items).toHaveLength(1)
  }
)

it.each([
  'queue',
  'queue-edit',
  'host',
  'submission',
  'resolved',
  'transition',
  'batch',
  'prior',
  'epoch',
  'live-goal-epoch',
  'accepted-goal-import',
  'unknown',
  'other-chat',
  'shared-refusal'
] as const)('protects shared/uncertain uses: %s', async (kind) => {
  const journal = await openJournal()
  const file = await storedGoalFile()
  const identity: AgentJournalItemIdentity = {
    provider: 'orca',
    clientMessageId: 'thread-goal:first'
  }
  const append = () =>
    journal.appendClaimingAttachments(
      identity,
      { ...file.body, sentAs: 'goal' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  if (kind === 'prior') {
    await journal.appendItem({ provider: 'orca', clientMessageId: 'prior' }, file.body, {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
  await append()
  if (kind === 'submission') {
    await journal.appendSubmission({
      clientMessageId: 'accepted',
      payloadFingerprint: 'fp',
      body: file.body,
      fence: 1,
      origin: 'host'
    })
  }
  if (kind === 'resolved') {
    await journal.appendResolvedItem(
      () => ({ identity: { provider: 'orca', clientMessageId: 'resolved' }, body: file.body }),
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  if (kind === 'transition') {
    await journal.appendSteps([
      {
        kind: 'item',
        resolve: () => ({
          identity: { provider: 'orca', clientMessageId: 'transition' },
          body: file.body
        }),
        options: { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      }
    ])
  }
  if (kind === 'batch') {
    await journal.appendLifecycleBatch({
      settlementId: 'accepted-input',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: { provider: 'orca', clientMessageId: 'batch' },
          body: file.body,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ]
    })
  }
  if (kind === 'live-goal-epoch') {
    await journal.rollEpoch('legacy_import', 1)
  }
  const database = openTestJournalHostDatabase(root ?? '')
  if (kind === 'queue') {
    await journal.queuedMessages.insert({ messageId: 'queued', body: file.body })
  }
  if (kind === 'queue-edit') {
    await journal.queuedMessages.insert({
      messageId: 'queued',
      body: { ...file.body, blocks: [{ type: 'text', text: 'before' }] }
    })
    await journal.queuedMessages.update({
      messageId: 'queued',
      text: formatNativeChatFileReference(file.path),
      expectedBodyFingerprint: journal.queuedMessages.get('queued')!.fingerprint
    })
  }
  if (kind === 'host') {
    await journal.appendItem({ provider: 'orca', clientMessageId: 'ordinary' }, file.body, {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
  if (kind === 'epoch' || kind === 'accepted-goal-import') {
    await journal.replaceEpochItems('legacy_import', 1, [
      {
        identity: { provider: 'orca', clientMessageId: 'imported' },
        body: kind === 'accepted-goal-import' ? { ...file.body, sentAs: 'goal' } : file.body,
        ownerFence: 1
      }
    ])
  }
  if (kind === 'other-chat') {
    const other = await journals.open({
      identity: { ...IDENTITY, sessionId: 'other' },
      stateDirectory: root ?? ''
    })
    await other.appendClaimingAttachments(
      { provider: 'orca', clientMessageId: 'ordinary' },
      file.body,
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  if (kind === 'shared-refusal') {
    const second: AgentJournalItemIdentity = {
      provider: 'orca',
      clientMessageId: 'thread-goal:second'
    }
    await journal.appendClaimingAttachments(
      second,
      { ...file.body, sentAs: 'goal' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.withdrawGoalObjective(identity, { fence: 1 })
    expect(
      database.db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()
    ).toHaveLength(1)
    await journal.withdrawGoalObjective(second, { fence: 1 })
    expect(
      database.db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()
    ).toHaveLength(0)
    return
  }
  if (kind === 'unknown') {
    await journal.close()
    closeTestJournalHostDatabase(root ?? '')
    const reopened = await openJournal()
    await expect(journal.withdrawGoalObjective(identity, { fence: 1 })).rejects.toThrow()
    await reopened.withdrawGoalObjective(identity, { fence: 1 })
  } else {
    await journal.withdrawGoalObjective(identity, { fence: 1 })
  }
  const claims = openTestJournalHostDatabase(root ?? '')
    .db.prepare('SELECT session_id FROM agent_session_attachment_claims')
    .all()
  expect(claims).toHaveLength(kind === 'live-goal-epoch' ? 0 : 1)
  expect(
    markUnclaimedUploadForSweep(openTestJournalHostDatabase(root ?? '').db, file.uploadId, 1)
  ).toBe(kind === 'live-goal-epoch')
})

it('keeps inverse and SQL synchronized across failed COMMIT and failed post-COMMIT publication', async () => {
  let failPublication = false
  const journal = await openJournal(() => {
    if (failPublication) {
      throw new Error('publication failed')
    }
  })
  const file = await storedGoalFile()
  const identity: AgentJournalItemIdentity = {
    provider: 'orca',
    clientMessageId: 'thread-goal:rollback'
  }
  await journal.appendClaimingAttachments(
    identity,
    { ...file.body, sentAs: 'goal' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const database = openTestJournalHostDatabase(root ?? '')
  const transaction = database.transaction.bind(database)
  const spy = vi.spyOn(database, 'transaction')
  spy.mockImplementationOnce((run) =>
    transaction((db) => {
      run(db)
      throw new Error('commit failed')
    })
  )
  await expect(journal.withdrawGoalObjective(identity, { fence: 1 })).rejects.toThrow(
    'commit failed'
  )
  expect(journal.snapshot().items).toHaveLength(1)
  expect(
    database.db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()
  ).toHaveLength(1)
  await journal.withdrawGoalObjective(identity, { fence: 1 })
  expect(
    database.db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()
  ).toHaveLength(0)
  expect(journal.snapshot().items).toHaveLength(0)
  // Once an ordinary row commits, fallible downstream publication cannot restore delete permission.
  await journal.appendClaimingAttachments(
    identity,
    { ...file.body, sentAs: 'goal' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  failPublication = true
  await expect(
    journal.appendItem({ provider: 'orca', clientMessageId: 'accepted' }, file.body, {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  ).rejects.toThrow('publication failed')
  failPublication = false
  await journal.withdrawGoalObjective(identity, { fence: 1 })
  expect(
    database.db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()
  ).toHaveLength(1)
  spy.mockRestore()
})

async function appendDurableAttachmentInput(
  journal: AgentSessionJournal,
  kind: 'step' | 'batch',
  identity: AgentJournalItemIdentity,
  body: AgentJournalMessageItem,
  settlementId: string
): Promise<unknown> {
  return kind === 'step'
    ? journal.appendSteps([
        {
          kind: 'item',
          resolve: () => ({ identity, body }),
          options: { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        }
      ])
    : journal.appendLifecycleBatch({
        settlementId,
        fence: 1,
        mutations: [{ kind: 'item', identity, body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }]
      })
}

it.each(['step', 'batch'] as const)(
  'protects independent %s input from no prior claim, atomically through rollback and publication failure',
  async (kind) => {
    let failPublication = false
    const journal = await openJournal(() => {
      if (failPublication) {
        throw new Error('publication failed')
      }
    })
    const file = await storedGoalFile()
    const database = openTestJournalHostDatabase(root ?? '')
    const claims = () =>
      database.db
        .prepare('SELECT upload_id FROM agent_session_attachment_claims WHERE upload_id = ?')
        .all(file.uploadId)
    const identity: AgentJournalItemIdentity = {
      provider: 'orca',
      clientMessageId: `independent-${kind}`
    }
    expect(claims()).toHaveLength(0)
    const transaction = database.transaction.bind(database)
    const spy = vi.spyOn(database, 'transaction').mockImplementationOnce((run) =>
      transaction((db) => {
        run(db)
        throw new Error('commit failed')
      })
    )
    await expect(
      appendDurableAttachmentInput(journal, kind, identity, file.body, 'rolled-back')
    ).rejects.toThrow('commit failed')
    expect(claims()).toHaveLength(0)
    expect(journal.snapshot().items).toHaveLength(0)
    failPublication = true
    await expect(
      appendDurableAttachmentInput(journal, kind, identity, file.body, 'accepted')
    ).rejects.toThrow('publication failed')
    failPublication = false
    expect(claims()).toHaveLength(1)
    await journal.close()
    closeTestJournalHostDatabase(root ?? '')
    const reopened = await openJournal()
    expect(reopened.snapshot().items.map((item) => item.body)).toContainEqual(file.body)
    expect(
      markUnclaimedUploadForSweep(openTestJournalHostDatabase(root ?? '').db, file.uploadId, 1)
    ).toBe(false)
    spy.mockRestore()
  }
)

it.each(['step', 'batch'] as const)(
  'distinguishes provisional goal self-restatement from independent %s input at COMMIT',
  async (kind) => {
    let failPublication = false
    const journal = await openJournal(() => {
      if (failPublication) {
        throw new Error('publication failed')
      }
    })
    const database = openTestJournalHostDatabase(root ?? '')
    for (const phase of ['self', 'rollback', 'accepted'] as const) {
      const file = await storedGoalFile()
      const identity: AgentJournalItemIdentity = {
        provider: 'orca',
        clientMessageId: `thread-goal:${phase}`
      }
      const body = { ...file.body, sentAs: 'goal' as const }
      await journal.appendClaimingAttachments(identity, body, {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      const other: AgentJournalItemIdentity = {
        provider: 'orca',
        clientMessageId: `independent:${phase}`
      }
      const append = () =>
        appendDurableAttachmentInput(
          journal,
          kind,
          phase === 'self' ? identity : other,
          phase === 'self'
            ? { ...body, blocks: [...body.blocks, { type: 'text', text: 'restated' }] }
            : file.body,
          phase
        )
      if (phase === 'rollback') {
        const transaction = database.transaction.bind(database)
        const spy = vi.spyOn(database, 'transaction').mockImplementationOnce((run) =>
          transaction((db) => {
            run(db)
            throw new Error('commit failed')
          })
        )
        await expect(append()).rejects.toThrow('commit failed')
        spy.mockRestore()
      } else if (phase === 'accepted') {
        failPublication = true
        await expect(append()).rejects.toThrow('publication failed')
        failPublication = false
      } else {
        await append()
      }
      await journal.withdrawGoalObjective(identity, { fence: 1 })
      expect(
        database.db
          .prepare('SELECT upload_id FROM agent_session_attachment_claims WHERE upload_id = ?')
          .all(file.uploadId)
      ).toHaveLength(phase === 'accepted' ? 1 : 0)
    }
  }
)
