import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  createRestTestRig,
  REST_TEST_CALLER as CALLER,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  HOST_TEST_SESSION as PARENT,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import {
  assistantRow,
  CHILD,
  CHILD_THREAD,
  forkRequest,
  messageTexts,
  providerHistory,
  seedForkParent
} from './structured-agent-session-fork.test-fixture'

let rig: RestTestRig
const fork = vi.fn<NonNullable<StructuredAgentSessionAdapter['forkConversation']>>()

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  rig.host.deps.adapter.forkConversation = fork
  fork.mockReset().mockImplementation(async ({ beforeFork, sessionId, lastTurnId }) => {
    await beforeFork()
    return {
      providerHandle: codexProviderHandle(CHILD_THREAD),
      items: providerHistory(
        sessionId,
        CHILD_THREAD,
        ['A', 'B', 'C'].slice(0, ['A', 'B', 'C'].indexOf(lastTurnId) + 1)
      )
    }
  })
})

afterEach(async () => {
  await rig.dispose()
})

function operationId() {
  return `${rig.clock.now}-${randomUUID().replaceAll('-', '')}`
}

it('materializes through B before publication, leaves the parent unchanged and inherits its folder/account/options', async () => {
  const journal = await seedForkParent(rig)
  const parent = journal.snapshot()
  const request = forkRequest(rig, assistantRow(parent.items, 'B').itemId, parent.cursor.epoch)
  const publishTab = vi.fn(async () => {
    expect(rig.store.getRecord(CHILD)?.providerHandleChain.at(-1)?.handle.nativeId).toBe(
      CHILD_THREAD
    )
    const imported = new AgentSessionJournal({
      database: openTestJournalHostDatabase(rig.root),
      identity: {
        sessionId: CHILD,
        workspaceId: 'folder-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle(CHILD_THREAD)
      }
    })
    await imported.open()
    const importedItems = imported.snapshot().items
    await imported.close()
    expect(messageTexts(importedItems)).toEqual([
      'question A',
      'answer A',
      'question B',
      'answer B'
    ])
  })
  const acquiredBefore = rig.adapter.acquire.mock.calls.length
  expect(await rig.host.fork(CALLER, request, { publishTab })).toMatchObject({
    ok: true,
    value: { sessionId: CHILD }
  })
  expect(fork).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      sessionId: CHILD,
      lastTurnId: 'B',
      record: expect.objectContaining({ sessionId: PARENT })
    })
  )
  expect(publishTab).toHaveBeenCalledOnce()
  expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquiredBefore)
  expect(journal.snapshot()).toEqual(parent)
  const original = rig.store.getRecord(PARENT)!
  expect(rig.store.getRecord(CHILD)).toMatchObject({
    accountHome: original.accountHome,
    location: original.location,
    options: { model: 'gpt-parent', effort: 'high' },
    permissionMode: 'ask',
    launchArgs: ['--disable', 'fast_mode'],
    forkedFrom: { sessionId: PARENT, itemId: request.forkFrom!.itemId }
  })
})

it('coalesces concurrent envelopes and replays after parent close and host restart without forking again', async () => {
  const journal = await seedForkParent(rig)
  const request = forkRequest(
    rig,
    assistantRow(journal.snapshot().items, 'B').itemId,
    journal.cursor().epoch
  )
  const replies = await Promise.all([
    rig.host.fork(CALLER, request),
    rig.host.fork(CALLER, request)
  ])
  expect(replies).toEqual([
    expect.objectContaining({ ok: true }),
    expect.objectContaining({ ok: true })
  ])
  expect(fork).toHaveBeenCalledOnce()
  await rig.host.close(PARENT, 'user-close')
  const requireRecord = rig.store.requireWritableRecord.bind(rig.store)
  const lookup = vi.spyOn(rig.store, 'requireWritableRecord').mockImplementation((id) => {
    if (id === PARENT) {
      throw new Error('The parent is unavailable')
    }
    return requireRecord(id)
  })
  expect(await rig.host.fork(CALLER, request)).toMatchObject({ ok: true, replayed: true })
  expect(lookup).not.toHaveBeenCalledWith(PARENT)
  lookup.mockRestore()
  const beforeRestart = rig.store.getOperationRow(
    CALLER.callerKey,
    request.envelope.clientOperationId
  )
  expect(beforeRestart?.expiresAt).toBeGreaterThan(Date.now())
  await rig.restart()
  expect(
    rig.store.getOperationRow(CALLER.callerKey, request.envelope.clientOperationId),
    JSON.stringify(beforeRestart)
  ).toEqual(beforeRestart)
  rig.host.deps.adapter.forkConversation = fork
  const replay = await rig.host.fork(CALLER, request)
  expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true, replayed: true })
  expect(fork).toHaveBeenCalledOnce()
  expect(rig.store.getRecord(CHILD)?.providerHandleChain.at(-1)?.handle.nativeId).toBe(CHILD_THREAD)
  expect(messageTexts((await rig.host.journalSnapshot(CHILD)).items)).toEqual([
    'question A',
    'answer A',
    'question B',
    'answer B'
  ])
  rig.adapter.acquire.mockImplementation(async ({ identity, fence, spawnToken }) => ({
    acquisitionGeneration: 'resumed-branch',
    process: { hostId: 'local', pid: 4243, processStartTimeMs: rig.clock.now, spawnToken },
    link: {
      linkId: `child-${fence}`,
      handle: identity.providerHandle!,
      origin: 'resumed',
      mintedAtFence: fence,
      observedAt: rig.clock.now
    }
  }))
  const child = rig.store.getRecord(CHILD)!
  const fence = child.lease.runtimeFence
  const attached = await rig.host.attach(
    CALLER,
    hostTestAttachParams(fence, {
      envelope: {
        sessionId: CHILD,
        clientOperationId: operationId(),
        expectedRuntimeFence: fence,
        payloadFingerprint: ''
      },
      location: child.location,
      accountHome: child.accountHome,
      providerHandle: { kind: 'codex', threadId: CHILD_THREAD }
    })
  )
  expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true })
  expect(rig.adapter.acquire).toHaveBeenLastCalledWith(
    expect.objectContaining({
      identity: expect.objectContaining({
        sessionId: CHILD,
        providerHandle: codexProviderHandle(CHILD_THREAD)
      })
    })
  )
  rig.adapter.dispatch.mockResolvedValueOnce({
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: CHILD_THREAD, turnId: 'D', ordinal: 0 }
  })
  const body = hostTestMessage('continue the branch')
  expect(
    await rig.host.send(CALLER, {
      body,
      envelope: {
        sessionId: CHILD,
        clientOperationId: operationId(),
        expectedRuntimeFence: rig.store.getRecord(CHILD)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: CHILD,
          fields: { body }
        })
      }
    })
  ).toMatchObject({ ok: true })
  await vi.waitFor(() =>
    expect(rig.adapter.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: CHILD })
    )
  )
  expect(fork).toHaveBeenCalledOnce()
})

it('refuses a stale epoch without provider effects', async () => {
  const journal = await seedForkParent(rig)
  const request = forkRequest(
    rig,
    assistantRow(journal.snapshot().items, 'B').itemId,
    journal.cursor().epoch + 1
  )
  expect(await rig.host.fork(CALLER, request)).toMatchObject({ ok: false })
  expect(fork).not.toHaveBeenCalled()
  expect(rig.store.getRecord(CHILD)).toBeNull()
})

it('allows an earlier completed answer while the later target is still running', async () => {
  const journal = await seedForkParent(rig)
  const writes: Promise<unknown>[] = []
  const translator = createCodexJournalTranslator({
    sessionId: PARENT,
    primaryThreadId: () => THREAD,
    sink: {
      appendItem: (identity, body, options) => {
        writes.push(journal.appendItem(identity, body, { ...options, ownerFence: 1, fence: 1 }))
      },
      appendTombstone: () => {
        throw new Error('Unexpected tombstone')
      },
      publish: () => {}
    }
  })
  translator.handle({
    type: 'notification',
    sessionId: PARENT,
    threadId: THREAD,
    method: 'turn/started',
    params: { turn: { id: 'C' } }
  })
  await Promise.all(writes)
  translator.dispose()
  const snapshot = journal.snapshot()
  expect(
    await rig.host.fork(
      CALLER,
      forkRequest(
        rig,
        assistantRow(snapshot.items, 'C').itemId,
        snapshot.cursor.epoch,
        'codex_running'
      )
    )
  ).toMatchObject({ ok: false })
  expect(fork).not.toHaveBeenCalled()
  expect(
    await rig.host.fork(
      CALLER,
      forkRequest(rig, assistantRow(snapshot.items, 'B').itemId, snapshot.cursor.epoch)
    )
  ).toMatchObject({ ok: true })
  expect(fork).toHaveBeenCalledOnce()
})

it('keeps post-fork import failures unknown across retries instead of reporting no effects or reforking', async () => {
  const journal = await seedForkParent(rig)
  const request = forkRequest(
    rig,
    assistantRow(journal.snapshot().items, 'B').itemId,
    journal.cursor().epoch
  )
  fork.mockImplementationOnce(async ({ beforeFork }) => {
    await beforeFork()
    throw new Error('Required Codex history exceeds the import limit')
  })
  const result = await rig.host.fork(CALLER, request)
  expect(result).toMatchObject({
    ok: false,
    refusal: {
      code: 'agent_session_operation_unknown',
      message: expect.stringContaining('import limit')
    }
  })
  if (!result.ok) {
    expect(result.refusal.createAttemptRefusedBeforeCommit).not.toBe(true)
  }
  expect(await rig.host.fork(CALLER, request)).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_unknown' }
  })
  expect(fork).toHaveBeenCalledOnce()
  expect(rig.store.getRecord(CHILD)).toBeNull()
})

it('does not claim effects when provider capability preflight rejects the cut point', async () => {
  const journal = await seedForkParent(rig)
  const request = forkRequest(
    rig,
    assistantRow(journal.snapshot().items, 'B').itemId,
    journal.cursor().epoch
  )
  fork.mockRejectedValueOnce(new Error('Installed Codex does not support lastTurnId'))
  const result = await rig.host.fork(CALLER, request)
  expect(result).toMatchObject({
    ok: false,
    refusal: {
      message: expect.stringContaining('lastTurnId'),
      createAttemptRefusedBeforeCommit: true
    }
  })
  expect(rig.store.getRecord(CHILD)).toBeNull()
  expect(rig.store.getOperationRow(CALLER.callerKey, request.envelope.clientOperationId)).toBeNull()
})

it('uses child provider turn identities when branching an imported branch again', async () => {
  const journal = await seedForkParent(rig)
  const request = forkRequest(
    rig,
    assistantRow(journal.snapshot().items, 'B').itemId,
    journal.cursor().epoch
  )
  expect(await rig.host.fork(CALLER, request)).toMatchObject({ ok: true })
  const child = await rig.host.journalSnapshot(CHILD)
  const selected = assistantRow(child.items, 'A')
  expect(selected.itemId).toContain(CHILD_THREAD)
  const nested = forkRequest(rig, selected.itemId, child.cursor.epoch, 'codex_grandchild', CHILD)
  fork.mockImplementationOnce(async ({ beforeFork, sessionId }) => {
    await beforeFork()
    return {
      providerHandle: codexProviderHandle('019fd532-7c11-7a90-b6de-4e1a2c3d5f62'),
      items: providerHistory(sessionId, '019fd532-7c11-7a90-b6de-4e1a2c3d5f62', ['A'])
    }
  })
  expect(await rig.host.fork(CALLER, nested)).toMatchObject({ ok: true })
  expect(fork).toHaveBeenLastCalledWith(
    expect.objectContaining({
      lastTurnId: 'A',
      record: expect.objectContaining({ sessionId: CHILD })
    })
  )
  expect(
    agentJournalItemKey(
      providerHistory(CHILD, CHILD_THREAD, ['A']).find(
        (item) => item.body.kind === 'message' && item.body.role === 'assistant'
      )!.identity
    )
  ).toBe(selected.itemId)
})

it.each(['clear', 'rewind'] as const)(
  'holds the parent %s mutation until native materialization finishes',
  async (command) => {
    const journal = await seedForkParent(rig)
    const snapshot = journal.snapshot()
    const request = forkRequest(
      rig,
      assistantRow(snapshot.items, 'B').itemId,
      snapshot.cursor.epoch
    )
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    fork.mockImplementationOnce(async ({ beforeFork, sessionId }) => {
      await beforeFork()
      entered.resolve()
      await release.promise
      expect(journal.snapshot()).toEqual(snapshot)
      return {
        providerHandle: codexProviderHandle(CHILD_THREAD),
        items: providerHistory(sessionId, CHILD_THREAD, ['A', 'B'])
      }
    })
    const branching = rig.host.fork(CALLER, request)
    await entered.promise
    const rewind = vi.fn(async () => ({ ok: true as const }))
    rig.host.deps.adapter.rewindSupport = () => ({ supported: true })
    rig.host.deps.adapter.rewind = rewind
    rig.host.deps.adapter.recoverRewind = async () => ({ ok: true })
    const target = snapshot.items.find(
      ({ body }) =>
        body.kind === 'message' &&
        body.role === 'user' &&
        body.blocks.some((block) => block.type === 'text' && block.text === 'question B')
    )!
    const fields =
      command === 'clear'
        ? { command: 'clear' as const }
        : { itemId: target.itemId, expectedEpoch: snapshot.cursor.epoch }
    const envelope = {
      sessionId: PARENT,
      clientOperationId: operationId(),
      expectedRuntimeFence: rig.store.getRecord(PARENT)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: command === 'clear' ? 'agentSession.conversationCommand' : 'agentSession.rewind',
        sessionId: PARENT,
        fields
      })
    }
    let settled = false
    const mutating = (
      command === 'clear'
        ? rig.host.conversationCommand(CALLER, { command: 'clear', envelope })
        : rig.host.rewind(CALLER, {
            itemId: target.itemId,
            expectedEpoch: snapshot.cursor.epoch,
            envelope
          })
    ).then((result) => {
      settled = true
      return result
    })
    try {
      await new Promise(setImmediate)
      expect(settled).toBe(false)
      expect(rewind).not.toHaveBeenCalled()
      expect(journal.snapshot()).toEqual(snapshot)
    } finally {
      release.resolve()
    }
    expect(await branching).toMatchObject({ ok: true })
    const mutation = await mutating
    expect(mutation, JSON.stringify(mutation)).toMatchObject({ ok: true })
    expect(messageTexts((await rig.host.journalSnapshot(CHILD)).items)).toEqual([
      'question A',
      'answer A',
      'question B',
      'answer B'
    ])
    expect(await rig.host.fork(CALLER, request)).toMatchObject({ ok: true, replayed: true })
    expect(fork).toHaveBeenCalledOnce()
    const current = journal.snapshot()
    if (command === 'clear') {
      const stale = forkRequest(
        rig,
        request.forkFrom!.itemId,
        current.cursor.epoch,
        'codex_behind_clear'
      )
      expect(await rig.host.fork(CALLER, stale)).toMatchObject({ ok: false })
      expect(fork).toHaveBeenCalledOnce()
    } else {
      const selected = assistantRow(current.items, 'A')
      const next = forkRequest(rig, selected.itemId, current.cursor.epoch, 'codex_after_rewind')
      fork.mockImplementationOnce(async ({ beforeFork, sessionId }) => {
        await beforeFork()
        const threadId = '019fd532-7c11-7a90-b6de-4e1a2c3d5f63'
        return {
          providerHandle: codexProviderHandle(threadId),
          items: providerHistory(sessionId, threadId, ['A'])
        }
      })
      expect(await rig.host.fork(CALLER, next)).toMatchObject({ ok: true })
      expect(fork).toHaveBeenLastCalledWith(expect.objectContaining({ lastTurnId: 'A' }))
    }
  }
)

it('refuses reversed missing parents without deadlocking their create lanes', async () => {
  const first = forkRequest(
    rig,
    'missing-answer',
    'missing-epoch',
    'codex_missing_a',
    'codex_missing_b'
  )
  const second = forkRequest(
    rig,
    'missing-answer',
    'missing-epoch',
    'codex_missing_b',
    'codex_missing_a'
  )
  expect(await Promise.all([rig.host.fork(CALLER, first), rig.host.fork(CALLER, second)])).toEqual([
    expect.objectContaining({ ok: false }),
    expect.objectContaining({ ok: false })
  ])
  expect(fork).not.toHaveBeenCalled()
}, 2_000)

it.each(['same-tick', 'native-fork-entered'] as const)(
  'includes a %s pending branch in workspace Sleep and leaves it asleep after materialization',
  async (timing) => {
    const journal = await seedForkParent(rig)
    const request = forkRequest(
      rig,
      assistantRow(journal.snapshot().items, 'B').itemId,
      journal.cursor().epoch
    )
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    fork.mockImplementationOnce(async ({ beforeFork, sessionId }) => {
      await beforeFork()
      entered.resolve()
      await release.promise
      return {
        providerHandle: codexProviderHandle(CHILD_THREAD),
        items: providerHistory(sessionId, CHILD_THREAD, ['A', 'B'])
      }
    })
    const publishTab = vi.fn(async () => {})
    const close = vi.spyOn(rig.host.collaboratorsForTests().lifetime, 'closeForWorkspaceSleep')
    const branching = rig.host.fork(CALLER, request, { publishTab })
    if (timing === 'native-fork-entered') {
      await entered.promise
    }
    let sleepFinished = false
    const sleeping = rig.host.sleepWorkspace('folder-1', true).then((result) => {
      sleepFinished = true
      return result
    })
    try {
      await entered.promise
      await new Promise(setImmediate)
      expect(close).toHaveBeenCalledWith(CHILD, 'folder-1', 'local')
      expect(sleepFinished).toBe(false)
      expect(publishTab).not.toHaveBeenCalled()
    } finally {
      release.resolve()
    }
    expect(await branching).toMatchObject({ ok: true })
    const slept = await sleeping
    expect(slept, JSON.stringify(slept)).toEqual({
      stoppedSessionIds: expect.arrayContaining([PARENT, CHILD])
    })
    expect(rig.store.getRecord(CHILD)?.sleptAt).toBe(rig.clock.now)
    expect(rig.host.collaboratorsForTests().sessions.get(CHILD)?.child ?? null).toBeNull()
    expect(publishTab).toHaveBeenCalledOnce()
    await new Promise(setImmediate)
    expect(rig.store.getRecord(CHILD)?.sleptAt).toBe(rig.clock.now)
    expect(publishTab).toHaveBeenCalledOnce()
    close.mockRestore()
  }
)
