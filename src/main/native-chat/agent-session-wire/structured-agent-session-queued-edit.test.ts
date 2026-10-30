import { startQueuedEditLease } from '../../../shared/queued-message-edit-lease'
import { acquired, fakeCodex } from '../../codex/codex-structured-session-adapter-fixture'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import {
  readQueuePublication,
  structuredQueueSendGate
} from './structured-agent-session-queued-publication'
import { shouldQueueStructuredAgentSessionSend } from './structured-agent-session-queued-messages'
import { QUEUED_MESSAGES_PUBLISHED_MAX_BYTES } from './structured-agent-session-queued-published-bytes'
import { QUEUED_MESSAGE_EDIT_LEASE_MS } from '../agent-session-journal/queued-message-edit-leases'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import type { AgentJournalSkillRef } from '../../../shared/agent-session-journal-types'
import type { QueuedMessageImageBlock } from '../../../shared/queued-message-edit'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})
afterEach(() => rig.dispose())

function journal() {
  const value = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!value) {
    throw new Error('missing test conversation')
  }
  return value
}
async function queue(text: string, options?: { internal: true }) {
  const result = await rig.send(text, 'queue-if-active', options).result
  if (!result.ok || !('queued' in result.value)) {
    throw new Error('not queued')
  }
  return result.value.queued.messageId
}
function fingerprint(id: string) {
  const card = journal().queuedMessages.get(id)
  if (!card) {
    throw new Error('missing card')
  }
  return card.fingerprint
}
function update(
  messageId: string,
  expected: string,
  text: string,
  operationId?: string,
  images?: QueuedMessageImageBlock[],
  queuedImageCards?: boolean,
  skills?: readonly AgentJournalSkillRef[]
) {
  const fields = {
    messageId,
    expectedBodyFingerprint: expected,
    text,
    ...(images ? { images } : {}),
    ...(skills !== undefined ? { skills } : {})
  }
  return rig.host.queuedMessageUpdate(QUEUED_RIG_CALLER, {
    envelope: rig.envelope(
      fields,
      'agentSession.queuedMessageUpdate',
      operationId ?? hostTestOperationId()
    ),
    ...fields,
    ...(queuedImageCards === undefined ? {} : { queuedImageCards })
  })
}
function hold(
  messageId: string,
  action: 'acquire' | 'renew' | 'release' = 'acquire',
  editId = 'edit-1',
  caller = QUEUED_RIG_CALLER
) {
  const common = { sessionId: HOST_TEST_SESSION, messageId, editId }
  return rig.host.queuedMessageEditHold(
    caller,
    action === 'acquire'
      ? { ...common, action, expectedBodyFingerprint: fingerprint(messageId) }
      : { ...common, action }
  )
}
function gate() {
  const host = { store: rig.store, sessions: rig.host.collaboratorsForTests().sessions }
  return structuredQueueSendGate(host, HOST_TEST_SESSION)
}
function publication() {
  return readQueuePublication(journal(), gate())
}
function published(id: string) {
  return publication().queuedMessages.find((message) => message.messageId === id)
}
function held() {
  return [...journal().queuedMessages.editLeases.heldIds()]
}

describe('saving a queued card in place', () => {
  it('keeps id and position and attributes an edited agent message to the user', async () => {
    await rig.workingSend()
    const from = { kind: 'agent' as const, senders: [], orchestration: null }
    const queued = await rig.send('original', 'queue-if-active', { internal: true, from }).result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('not queued')
    }
    const id = queued.value.queued.messageId
    const before = journal().queuedMessages.get(id)!
    expect(await update(id, before.fingerprint, '/compact')).toMatchObject({
      ok: true,
      value: { status: 'updated' }
    })
    const { from: _sender, ...plain } = before.body
    const body = { ...plain, blocks: [{ type: 'text' as const, text: '/compact' }] }
    expect(journal().queuedMessages.get(id)).toEqual({
      ...before,
      body,
      fingerprint: agentSessionSendBodyFingerprint(HOST_TEST_SESSION, body)
    })
    expect(published(id)?.body).toEqual(body)
  })

  it('replaces skills including an empty set, reconciles lost replies and reopens the durable user-authored body', async () => {
    await rig.workingSend()
    const from = { kind: 'agent' as const, senders: [], orchestration: null }
    const originalSkill = { name: 'review', path: '/remote/old/SKILL.md' }
    const nextSkill = { name: 'review', path: '/remote/new/SKILL.md' }
    const row = await journal().queuedMessages.insert({
      messageId: 'skill-card',
      body: {
        ...hostTestMessage('$review this'),
        from,
        skills: [originalSkill]
      }
    })
    expect(await update(row.messageId, row.fingerprint, '$review this')).toMatchObject({
      value: { status: 'unchanged' }
    })
    expect(published(row.messageId)?.body.from).toEqual(from)
    expect(
      await update(row.messageId, '0'.repeat(64), '$review this', undefined, undefined, undefined, [
        nextSkill
      ])
    ).toMatchObject({ value: { status: 'changed' } })
    expect(published(row.messageId)?.body.from).toEqual(from)
    const operation = hostTestOperationId()
    expect(
      await update(
        row.messageId,
        row.fingerprint,
        '$review this',
        operation,
        undefined,
        undefined,
        [nextSkill]
      )
    ).toMatchObject({ value: { status: 'updated' } })
    expect(
      await update(
        row.messageId,
        row.fingerprint,
        '$review this',
        operation,
        undefined,
        undefined,
        [nextSkill]
      )
    ).toMatchObject({ value: { status: 'unchanged' } })
    expect(published(row.messageId)?.body.skills).toEqual([nextSkill])
    expect(published(row.messageId)?.body).not.toHaveProperty('from')
    await rig.restartHostProcess()
    await rig.drafts()
    expect(published(row.messageId)?.body.skills).toEqual([nextSkill])
    expect(published(row.messageId)?.body).not.toHaveProperty('from')
    expect(
      await update(
        row.messageId,
        fingerprint(row.messageId),
        '$review this',
        undefined,
        undefined,
        undefined,
        []
      )
    ).toMatchObject({ value: { status: 'updated' } })
    expect(published(row.messageId)?.body).not.toHaveProperty('skills')
  })

  it('preserves omitted skills on a no-op from an old phone and drops them only on its content-changing edit', async () => {
    await rig.workingSend()
    const row = await journal().queuedMessages.insert({
      messageId: 'legacy-skills',
      body: {
        ...hostTestMessage('$review this'),
        skills: [{ name: 'review', path: '/skills/review.md' }],
        from: { kind: 'agent', senders: [], orchestration: null }
      }
    })
    expect(await update(row.messageId, row.fingerprint, '$review this')).toMatchObject({
      value: { status: 'unchanged' }
    })
    expect(published(row.messageId)?.body.skills).toHaveLength(1)
    expect(await update(row.messageId, row.fingerprint, '$review that')).toMatchObject({
      value: { status: 'updated' }
    })
    expect(published(row.messageId)?.body).not.toHaveProperty('skills')
    expect(published(row.messageId)?.body).not.toHaveProperty('from')
  })

  it('a resent Save reads the card as it stands and never overwrites newer text', async () => {
    await rig.workingSend()
    const id = await queue('base')
    const base = fingerprint(id)
    const operation = hostTestOperationId()
    expect(await update(id, base, 'mine', operation)).toMatchObject({
      value: { status: 'updated' }
    })
    expect(await update(id, base, 'mine', operation)).toMatchObject({
      value: { status: 'unchanged' }
    })
    expect(await update(id, fingerprint(id), 'newer')).toMatchObject({
      value: { status: 'updated' }
    })
    expect(await update(id, base, 'mine', operation)).toMatchObject({
      value: { status: 'changed' }
    })
    expect(await update(id, base, 'another draft')).toMatchObject({
      value: { status: 'changed' }
    })
    expect(journal().queuedMessages.get(id)?.body.blocks).toEqual([{ type: 'text', text: 'newer' }])
  })

  it('after Send or Delete elsewhere, Save answers gone and recreates nothing', async () => {
    await rig.workingSend()
    const deleted = await queue('deleted')
    const sent = await queue('sent')
    const bases = [fingerprint(deleted), fingerprint(sent)] as const
    await rig.deleteQueued(deleted)
    await rig.sendNow(sent)
    expect(await update(deleted, bases[0], 'edit')).toMatchObject({
      value: { status: 'gone', disposition: 'withdrawn' }
    })
    expect(await update(sent, bases[1], 'edit')).toMatchObject({
      value: { status: 'gone', disposition: 'dispatched' }
    })
    expect(await rig.drafts()).toEqual([])
  })

  it('counts the edited card once against the queue size bound', async () => {
    await rig.workingSend()
    const big = await queue('x'.repeat(QUEUED_MESSAGES_PUBLISHED_MAX_BYTES - 120 * 1024))
    const small = await queue('small')
    expect(await update(small, fingerprint(small), 'y'.repeat(200 * 1024))).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'queueTooLarge' } }
    })
    expect(journal().queuedMessages.get(small)?.body.blocks).toEqual([
      { type: 'text', text: 'small' }
    ])
    expect(await update(big, fingerprint(big), 'z'.repeat(250 * 1024))).toMatchObject({
      ok: true,
      value: { status: 'updated' }
    })
  })

  it('a command card is not editable', async () => {
    await rig.workingSend()
    const body = { ...hostTestMessage('/compact'), command: { name: 'compact' } }
    const command = await journal().queuedMessages.insert({
      messageId: 'command-card',
      body
    })
    expect(await hold(command.messageId)).toEqual({ status: 'not-editable' })
    expect(await update(command.messageId, command.fingerprint, 'text')).toMatchObject({
      value: { status: 'not-editable' }
    })
  })
})

describe("saving a queued card's images", () => {
  const A = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c0a'
  const B = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c0b'
  const GONE = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c0c'
  const upload = (uploadId: string) => join(agentSessionAttachmentStoreRoot(rig.root), uploadId)
  const image = (uploadId: string): QueuedMessageImageBlock => ({
    type: 'image-ref',
    path: join(upload(uploadId), 'shot.png')
  })
  async function store(uploadId: string) {
    await mkdir(upload(uploadId), { recursive: true })
    await writeFile(join(upload(uploadId), 'shot.png'), 'bytes')
  }

  it('replaces the set by compare-and-set; only a newly named upload must still be stored', async () => {
    await rig.workingSend()
    await store(A)
    await store(B)
    const id = await queue('caption')
    const base = fingerprint(id)
    const operation = hostTestOperationId()
    const both = [image(A), image(B)]
    const caption = 'caption [Image #1] [Image #2]'
    expect(await update(id, base, `${caption} `, operation, both)).toMatchObject({
      value: { status: 'updated' }
    })
    const blocks = journal().queuedMessages.get(id)?.body.blocks
    expect(blocks).toEqual([{ type: 'text', text: caption }, ...both])
    expect(await update(id, base, `${caption} `, operation, both)).toMatchObject({
      value: { status: 'unchanged' }
    })
    expect(await update(id, base, 'caption', undefined, [image(B)])).toMatchObject({
      value: { status: 'changed' }
    })
    // Missing retained uploads must allow text-only edits without dropping images.
    await rm(upload(A), { recursive: true })
    expect(await update(id, fingerprint(id), 'fixed')).toMatchObject({
      value: { status: 'updated' }
    })
    expect(journal().queuedMessages.get(id)?.body.blocks).toEqual([
      { type: 'text', text: 'fixed' },
      ...both
    ])
    const before = journal().queuedMessages.get(id)
    expect(
      await update(id, fingerprint(id), 'fixed', undefined, [image(B), image(GONE)])
    ).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid', details: { reason: 'attachmentExpired' } }
    })
    expect(journal().queuedMessages.get(id)).toEqual(before)
  })

  it('a caller shown no image cards may not add one', async () => {
    await rig.workingSend()
    await store(A)
    const id = await queue('text only')
    expect(
      await update(id, fingerprint(id), 'text only', undefined, [image(A)], false)
    ).toMatchObject({ value: { status: 'not-editable' } })
    expect(journal().queuedMessages.get(id)?.body.blocks).toEqual([
      { type: 'text', text: 'text only' }
    ])
  })
})

describe('edit leases and automatic delivery', () => {
  it('earlier cards deliver; the edited card and those behind it wait; a new send still queues', async () => {
    const work = await rig.workingSend()
    const first = await queue('first')
    const edited = await queue('edited')
    const last = await queue('last')
    expect(await hold(edited)).toMatchObject({ status: 'held', leaseDurationMs: 120_000 })
    expect(held()).toEqual([edited])
    expect(published(edited)?.paused).toBeUndefined()
    await rig.settleAccepted(work, 'work-done')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    await rig.settleAccepted(await rig.handoffId(first), 'first-done')
    expect(publication().nextQueuedMessageId).toBeNull()
    expect(journal().queuedMessages.get(edited)?.state).toBe('waiting')
    expect(journal().queuedMessages.get(last)?.state).toBe('waiting')
    expect(
      shouldQueueStructuredAgentSessionSend({
        journal: journal(),
        ...gate()(journal())
      })
    ).toBe(true)
    expect(await rig.sendNow(edited)).toMatchObject({ ok: true })
    expect(journal().queuedMessages.editLeases.heldIds().size).toBe(0)
  })

  it('drains changed selected skills into the recorded Codex input shape by path', async () => {
    const working = await rig.workingSend()
    const id = await queue('$review original')
    const selected = { name: 'review', path: '/work/repo/.agents/skills/review/SKILL.md' }
    expect(
      await update(id, fingerprint(id), '$review changed', undefined, undefined, undefined, [
        selected
      ])
    ).toMatchObject({ value: { status: 'updated' } })
    await rig.settleAccepted(working, 'work-done')
    await eventually(async () => expect(await rig.handoff(id)).toBeDefined())
    await eventually(() =>
      expect(
        rig.dispatch.mock.calls.some(([input]) =>
          input.body.skills?.some((skill) => skill.path === selected.path)
        )
      ).toBe(true)
    )
    const consumed = rig.dispatch.mock.calls.find(([input]) =>
      input.body.skills?.some((skill) => skill.path === selected.path)
    )?.[0]
    expect(consumed?.body.skills).toEqual([selected])
    if (!consumed) {
      throw new Error('queue did not dispatch')
    }
    const codex = fakeCodex({
      'skills/list': () => ({
        data: [
          {
            cwd: '/work/repo',
            skills: [{ ...selected, description: 'Review changes', scope: 'user', enabled: true }],
            errors: []
          }
        ]
      }),
      'turn/start': () => ({ turn: { id: 'turn-1' } })
    })
    const adapter = await acquired(codex)
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: consumed.clientMessageId,
      fence: 7,
      body: consumed.body
    })
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params?.input
    ).toEqual([
      { type: 'text', text: '$review changed' },
      { type: 'skill', ...selected }
    ])
  })

  it('Save then release lets the edited card drain with its new text', async () => {
    const work = await rig.workingSend()
    const id = await queue('before')
    await hold(id)
    await rig.settleAccepted(work, 'work-done')
    expect(await update(id, fingerprint(id), 'after')).toMatchObject({
      value: { status: 'updated' }
    })
    expect(held()).toEqual([])
    await hold(id, 'release')
    await eventually(async () => expect(await rig.handoff(id)).toBeDefined())
    const submissions = (await rig.host.journalSnapshot(HOST_TEST_SESSION)).submissions
    expect(submissions.at(-1)?.payloadFingerprint).toBe(
      agentSessionSendBodyFingerprint(HOST_TEST_SESSION, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'after' }]
      })
    )
  })

  it("one editor's release keeps another's hold; a renewal re-sends nothing and is not activity", async () => {
    await rig.workingSend()
    const id = await queue('base')
    await hold(id)
    await hold(id, 'acquire', 'edit-1', { callerKey: 'phone' })
    const before = publication()
    const touch = vi.spyOn(rig.host.collaboratorsForTests().sessions, 'touch')
    expect(await hold(id, 'renew')).toMatchObject({ status: 'held' })
    // Editor renewal must not keep the provider process alive.
    expect(touch).not.toHaveBeenCalled()
    expect(publication()).toBe(before)
    expect(await hold(id, 'release')).toEqual({ status: 'released' })
    expect(held()).toEqual([id])
    await hold(id, 'release', 'edit-1', { callerKey: 'phone' })
    expect(held()).toEqual([])
  })

  it('acquiring after delivery won answers gone; Save without a lease still works', async () => {
    await rig.workingSend()
    const id = await queue('base')
    expect(await update(id, fingerprint(id), 'saved')).toMatchObject({
      value: { status: 'updated' }
    })
    await rig.sendNow(id)
    expect(
      await rig.host.queuedMessageEditHold(QUEUED_RIG_CALLER, {
        sessionId: HOST_TEST_SESSION,
        messageId: id,
        editId: 'late',
        action: 'acquire',
        expectedBodyFingerprint: 'f'.repeat(64)
      })
    ).toEqual({ status: 'gone' })
  })

  it('a lapsed lease wakes delivery with no journal activity, even when publishing fails', async () => {
    const work = await rig.workingSend()
    const id = await queue('edited')
    let clock = 0
    const time = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await hold(id)
      await rig.settleAccepted(work, 'work-done')
      await vi.advanceTimersByTimeAsync(0)
      expect(publication().nextQueuedMessageId).toBeNull()
      const publish = vi
        .spyOn(rig.host.collaboratorsForTests().subscribers, 'publish')
        .mockImplementationOnce(() => {
          throw new Error('publication failed')
        })
      clock = QUEUED_MESSAGE_EDIT_LEASE_MS
      await vi.advanceTimersByTimeAsync(QUEUED_MESSAGE_EDIT_LEASE_MS)
      publish.mockRestore()
      vi.useRealTimers()
      await eventually(async () => expect(await rig.handoff(id)).toBeDefined())
    } finally {
      vi.useRealTimers()
      time.mockRestore()
    }
  })

  it('Stop and Resume leave the edit hold alone and never publish it as a pause', async () => {
    await rig.workingSend()
    const id = await queue('base')
    await hold(id)
    await rig.stop()
    await rig.resume()
    expect(held()).toEqual([id])
    expect(published(id)?.paused).toBeUndefined()
    expect(publication().nextQueuedMessageId).toBeNull()
  })

  it('an edit open across /clear keeps its hold and saves into the same card', async () => {
    const working = await rig.workingSend()
    const id = await queue('before clear')
    await hold(id)
    await rig.stop()
    await rig.settleAccepted(working, 'answer')
    const fields = { command: 'clear' as const }
    expect(
      await rig.host.conversationCommand(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true })
    expect(held()).toEqual([id])
    expect(await update(id, fingerprint(id), 'after clear')).toMatchObject({
      value: { status: 'updated' }
    })
    expect(published(id)?.body.blocks).toEqual([{ type: 'text', text: 'after clear' }])
    expect(publication().queuePause).toBeNull()
    expect(journal().queuedMessages.get(id)?.state).toBe('waiting')
  })

  it('release never opens a closed conversation; closing drops every lease', async () => {
    await rig.workingSend()
    const id = await queue('base')
    await hold(id)
    const leases = journal().queuedMessages.editLeases
    await rig.host.close(HOST_TEST_SESSION, 'evict')
    expect(leases.heldIds([]).size).toBe(0)
    expect(await hold(id, 'release')).toEqual({ status: 'released' })
    expect(rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)).toBeUndefined()
  })
})

it('real lease replacement survives an old delayed release; delivery may beat later reacquisition', async () => {
  await rig.workingSend()
  const id = await queue('base')
  let releaseOld: (() => Promise<void>) | undefined
  const request = (editId: string, expectedBodyFingerprint: string, delayRelease = false) =>
    startQueuedEditLease({
      sessionId: HOST_TEST_SESSION,
      messageId: id,
      editId,
      expectedBodyFingerprint,
      onLost: () => {},
      request: async (params) => {
        if (params.action === 'release' && delayRelease) {
          return new Promise((resolve) => {
            releaseOld = async () => {
              resolve(await rig.host.queuedMessageEditHold(QUEUED_RIG_CALLER, params))
            }
          })
        }
        return rig.host.queuedMessageEditHold(QUEUED_RIG_CALLER, params)
      }
    })
  const old = request('before-commit', fingerprint(id), true)
  expect(await old.acquired).toMatchObject({ status: 'held' })
  expect(await update(id, fingerprint(id), 'accepted')).toMatchObject({
    value: { status: 'updated' }
  })
  expect(held()).toEqual([])
  old.end()
  const replacement = request('after-proof', fingerprint(id))
  expect(await replacement.acquired).toMatchObject({ status: 'held' })
  await eventually(async () => expect(releaseOld).toBeDefined())
  await releaseOld!()
  expect(held()).toEqual([id])
  replacement.end()
  await eventually(async () => expect(held()).toEqual([]))
  await rig.sendNow(id)
  const late = request('delivery-won', fingerprint(id))
  expect(await late.acquired).toMatchObject({ status: 'gone' })
  late.end()
})

it.each(['retry-not-editable', 'renew-gone'] as const)(
  'shared lease delivers %s from the actual host wire boundary',
  async (mode) => {
    await rig.workingSend()
    const row =
      mode === 'retry-not-editable'
        ? await journal().queuedMessages.insert({
            messageId: 'wire-command',
            body: { ...hostTestMessage('/compact'), command: { name: 'compact' } }
          })
        : journal().queuedMessages.get(await queue('A'))!
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onLost = vi.fn()
    const request = vi.fn((params: Parameters<typeof rig.host.queuedMessageEditHold>[1]) =>
      rig.host.queuedMessageEditHold(QUEUED_RIG_CALLER, params)
    )
    if (mode === 'retry-not-editable') {
      request.mockRejectedValueOnce(new Error('offline'))
    }
    const lease = startQueuedEditLease({
      sessionId: HOST_TEST_SESSION,
      messageId: row.messageId,
      editId: 'wire-terminal',
      expectedBodyFingerprint: row.fingerprint,
      request,
      onLost
    })
    let missing: MockInstance<typeof rig.store.getConversation> | undefined
    try {
      if (mode === 'retry-not-editable') {
        await expect(lease.acquired).rejects.toThrow('offline')
      } else {
        expect(await lease.acquired).toMatchObject({ status: 'held' })
        await rig.host.close(HOST_TEST_SESSION, 'evict')
        missing = vi.spyOn(rig.store, 'getConversation').mockReturnValue(null)
      }
      await vi.advanceTimersByTimeAsync(30_000)
      expect(onLost).toHaveBeenCalledOnce()
      expect(onLost).toHaveBeenCalledWith({
        lease,
        expected: row.fingerprint,
        status: mode === 'retry-not-editable' ? 'not-editable' : 'gone'
      })
      expect(request.mock.calls.map(([params]) => params.action)).toEqual([
        'acquire',
        mode === 'retry-not-editable' ? 'acquire' : 'renew'
      ])
      lease.end()
      await vi.advanceTimersByTimeAsync(0)
      const count = request.mock.calls.length
      await vi.advanceTimersByTimeAsync(120_000)
      expect(request).toHaveBeenCalledTimes(count)
      expect(onLost).toHaveBeenCalledOnce()
    } finally {
      lease.end()
      await vi.advanceTimersByTimeAsync(0)
      missing?.mockRestore()
      warn.mockRestore()
      vi.useRealTimers()
    }
  }
)
