import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  THREAD_ID,
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor
} from '../../codex/codex-structured-session-adapter-fixture'
import type { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig
let adapter: CodexStructuredSessionAdapter | undefined
beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})
afterEach(async () => {
  await adapter?.closeAll()
  adapter = undefined
  await rig.dispose()
})

function journal() {
  const value = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!value) {
    throw new Error('expected an open journal')
  }
  return value
}
function currentEnvelope(fields: Record<string, unknown>, method: string, id: string) {
  return {
    ...rig.envelope(fields, method, id),
    expectedRuntimeFence: rig.store.getRecord(SESSION)!.lease.runtimeFence
  }
}
async function send(body: AgentJournalMessageItem, options: Record<string, string> = {}) {
  const id = hostTestOperationId()
  const fields = { body, options }
  expect(
    await rig.host.send(CALLER, {
      envelope: currentEnvelope(fields, 'agentSession.send', id),
      ...fields,
      userSend: true
    })
  ).toMatchObject({ ok: true, value: { clientMessageId: id } })
  return id
}

it.each(['before', 'after', 'none'] as const)(
  'does not turn an unopened Codex turn end into delivery proof (%s interrupt answer)',
  async (end) => {
    const codex = fakeCodex()
    codex.routes['turn/start'] = () => ({ turn: { id: 'turn-1' } })
    const ended = () =>
      codex.connections[0].handlers.onNotification?.('turn/completed', {
        threadId: THREAD_ID,
        turn: { id: 'turn-1', status: 'interrupted' }
      })
    codex.routes['turn/interrupt'] = () => {
      if (end === 'before') {
        ended()
      }
      return {}
    }
    adapter = adapterFor(codex, { codexHome: '/codex/home' })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor(SESSION),
      fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
      spawnToken: 'spawn-unstarted',
      events: rig.providerEvents()
    })
    const provider = adapter
    rig.dispatch.mockImplementation((input) => provider.dispatch(input))
    rig.cancelTurn.mockImplementation((input) => provider.cancelTurn(input))
    const body = hostTestMessage('first send')
    const id = await send(body)
    await eventually(async () => expect((await rig.submission(id))?.handedOverAt).toBeDefined())

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    if (end === 'after') {
      ended()
    }
    await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
    await rig.host.flushStreamedEvents(SESSION)

    expect(journal().receiptFor(id)).toBeNull()
    expect(journal().itemBody(agentJournalSubmissionKey(id))).toEqual(body)
    expect((await rig.submission(id))?.dispatchState).toBe('unknown')
    expect(
      (await rig.host.journalSnapshot(SESSION)).items.filter((row) => row.body.kind === 'turn')
    ).toEqual([])
    expect(await rig.drafts()).toEqual([])
  }
)

it.each(['partial', 'failed'] as const)(
  'retains an unopened Codex turn with actual %s output without inferring delivery',
  async (output) => {
    const codex = fakeCodex()
    codex.routes['turn/start'] = () => ({ turn: { id: 'turn-1' } })
    adapter = adapterFor(codex, { codexHome: '/codex/home' })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor(SESSION),
      fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
      spawnToken: 'spawn-observed',
      events: rig.providerEvents()
    })
    const provider = adapter
    rig.dispatch.mockImplementation((input) => provider.dispatch(input))
    const id = await send(hostTestMessage('original input'))
    await eventually(async () => expect((await rig.submission(id))?.handedOverAt).toBeDefined())
    const notify = codex.connections[0].handlers.onNotification
    if (output === 'partial') {
      notify?.('item/completed', {
        threadId: THREAD_ID,
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'message-1', text: 'partial' }
      })
    }
    notify?.('turn/completed', {
      threadId: THREAD_ID,
      turn: {
        id: 'turn-1',
        status: output === 'partial' ? 'interrupted' : 'failed',
        ...(output === 'failed' ? { error: { message: 'model overloaded' } } : {})
      }
    })
    await rig.host.flushStreamedEvents(SESSION)
    expect(
      (await rig.host.journalSnapshot(SESSION)).items.filter((row) => row.body.kind === 'turn')
    ).toMatchObject([{ body: { turnId: 'turn-1' } }])
    expect(journal().receiptFor(id)).toBeNull()
    expect((await rig.submission(id))?.dispatchState).not.toBe('rejected')
  }
)

it('keeps full unconfirmed input through accepted Stop, a resumed send, exact late proof and reopen', async () => {
  const dir = join(
    agentSessionAttachmentStoreRoot(rig.root),
    '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c0a'
  )
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'shot.png')
  await writeFile(path, 'fixture image bytes')
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text: 'original with image' },
      { type: 'image-ref', path }
    ]
  }
  const options = { model: 'default', serviceTier: 'priority' }
  const id = await send(body, options)
  await eventually(async () => expect((await rig.submission(id))?.handedOverAt).toBeDefined())
  rig.cancelTurn.mockRejectedValueOnce(new Error('interrupt answer lost'))
  let observed = false
  rig.closeSession.mockImplementationOnce(async (sessionId, observeClose) => {
    expect(sessionId).toBe(SESSION)
    expect(observeClose).toBeTypeOf('function')
    observeClose?.({ root: 'exited', workload: 'exited' })
    observed = true
    return true
  })

  expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
  await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
  expect(observed).toBe(true)
  expect(await rig.submission(id)).toMatchObject({ dispatchState: 'unknown', options })
  expect(journal().receiptFor(id)).toBeNull()
  expect(await rig.drafts()).toEqual([])
  const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(page).toMatchObject({
    ok: true,
    page: {
      queuedMessages: [],
      items: expect.arrayContaining([
        expect.objectContaining({ itemId: agentJournalSubmissionKey(id), body })
      ])
    }
  })
  expect(journal().queuedMessages.get(`recovery:${id}`)).toBeNull()
  expect(journal().submissionBody(id)).toEqual(body)
  expect(rig.dispatch.mock.calls[0]?.[0]).toMatchObject({
    clientMessageId: id,
    body,
    executionOptions: options
  })
  const newer = await send(hostTestMessage('new instruction after Stop'))
  await eventually(async () => expect((await rig.submission(newer))?.handedOverAt).toBeDefined())
  expect(rig.dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([id, newer])
  expect(journal().itemBody(agentJournalSubmissionKey(id))).toEqual(body)

  await rig.settleAccepted(id, 'late-original-echo')
  expect(journal().receiptFor(id)).not.toBeNull()
  expect((await rig.submission(newer))?.dispatchState).toBe('pending')
  expect(await rig.drafts()).toEqual([])
  await rig.settleAccepted(newer, 'newer-echo')
  await rig.restartHostProcess()
  expect(await rig.drafts()).toEqual([])
  expect(journal().itemBody(agentJournalSubmissionKey(id))).toEqual(body)
  expect(await rig.submission(id)).toMatchObject({ dispatchState: 'accepted', options })
  expect(await rig.drafts()).toEqual([])
  expect(rig.dispatch).toHaveBeenCalledTimes(2)
})
