import { createElement } from 'react'
import { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import { queuedMessageWithEdit } from '../../../src/shared/queued-message-edit'
import { queuedMessageUpdateDecision } from '../../../src/main/native-chat/agent-session-journal/queued-message-update'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../transport/types'
import {
  mobileNativeChatDraftDestination,
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import { setMobileNativeChatDraftText } from './native-chat/composer/mobile-native-chat-draft-store'
import {
  SESSION_ID,
  batchEvent,
  fieldsOf,
  mutationOk,
  queuedDraft
} from './use-mobile-structured-agent-session-queued.test-fixture'
import {
  mobileQueuedEditHarness,
  withText,
  readOrHoldReply
} from './mobile-queued-edit-hook.test-fixture'

describe('mobile queued replacement contracts', () => {
  const { state, Harness, mount, sendRequest, append, notice, resolved, requestedFingerprint } =
    mobileQueuedEditHarness()
  it.each(['refused', 'unknown-committed', 'unknown-refused-unchanged'] as const)(
    'restored seed after %s follows host CAS without a stale accepted action',
    async (mode) => {
      const message = queuedDraft({
        messageId: 'seed',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'base' }] }
      })
      await mount(message)
      const updates = () =>
        sendRequest.mock.calls.filter(([method]) => method === 'agentSession.queuedMessageUpdate')
          .length
      sendRequest.mockImplementation(async (method, params) => {
        if (method !== 'agentSession.queuedMessageUpdate') {
          return readOrHoldReply(method, params)
        }
        if (mode === 'refused') {
          return mutationOk({ status: 'not-editable', messageId: 'seed' })
        }
        throw markRpcDeliveryUnknown(new Error('lost'))
      })
      act(() => state.hook!.queued.editor!.change('attempt'))
      await act(async () => {
        await state.hook!.queued.editor!.save()
      })
      if (mode === 'unknown-refused-unchanged') {
        sendRequest.mockImplementation(async (method, params) =>
          method === 'agentSession.queuedMessageUpdate'
            ? mutationOk({ status: 'not-editable', messageId: 'seed' })
            : readOrHoldReply(method, params)
        )
        act(() => state.hook!.queued.editor!.change('refused later'))
        await act(async () => {
          await state.hook!.queued.editor!.save()
        })
      }
      act(() => state.hook!.queued.editor!.change('base'))
      const before = updates()
      sendRequest.mockImplementation(async (method, params) => {
        if (method !== 'agentSession.queuedMessageUpdate') {
          return readOrHoldReply(method, params)
        }
        const body = mode === 'unknown-committed' ? withText(message.body, 'attempt') : message.body
        const result = queuedMessageUpdateDecision(
          {
            messageId: 'seed',
            position: 1,
            body,
            fingerprint: agentSessionSendBodyFingerprint(SESSION_ID, body),
            state: 'waiting',
            holdReason: null,
            returnedReason: null,
            returnedRejection: null,
            consumedAs: null,
            queuedAt: null
          },
          SESSION_ID,
          {
            messageId: 'seed',
            expectedBodyFingerprint: String(fieldsOf(params).expectedBodyFingerprint),
            text: String(fieldsOf(params).text)
          }
        )
        if (result.status === 'ready') {
          throw new Error('unexpected ready')
        }
        return mutationOk(result)
      })
      await act(async () => {
        await state.hook!.queued.editor!.save()
      })
      expect(updates()).toBe(before + (mode === 'refused' ? 0 : 1))
      if (mode === 'unknown-refused-unchanged') {
        expect(state.hook!.queued.editor).toMatchObject({
          text: 'base',
          saving: false,
          canSave: true
        })
        act(() => state.listener?.(batchEvent([{ ...message }])))
        expect(state.hook!.queued.editor).toBeDefined()
        expect(resolved).not.toHaveBeenCalled()
      } else {
        expect(state.hook!.queued.editor).toBeUndefined()
      }
      expect(append).toHaveBeenCalledTimes(mode === 'unknown-committed' ? 1 : 0)
      expect(notice).toHaveBeenCalledTimes(mode === 'unknown-committed' ? 1 : 0)
    }
  )

  it('joins state.menu re-pick after unknown proof to a complete next Save RPC and retained tray', async () => {
    const message = queuedDraft({
      messageId: 'rich-proof',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '$review original' }],
        skills: [{ name: 'review', path: '/A/SKILL.md' }]
      }
    })
    await mount(message)
    act(() => state.hook!.queued.editor!.cancel())
    await act(async () =>
      state.renderer?.update(
        createElement(Harness, {
          skillsSupport: true,
          imagesSupport: true,
          composerScopeKey: 'original-bottom'
        })
      )
    )
    await act(async () => {
      await state.hook!.queued.edit!('rich-proof')
    })
    act(() => setMobileNativeChatDraftText('original-bottom', 'occupied'))
    sendRequest.mockImplementation(async (method, params) => {
      if (method === 'agentSession.queuedMessageUpdate') {
        throw markRpcDeliveryUnknown(new Error('lost'))
      }
      return readOrHoldReply(method, params)
    })
    act(() => state.hook!.queued.editor!.change('$review'))
    await act(async () => {
      await state.hook!.queued.editor!.save()
    })
    vi.stubGlobal('structuredClone', undefined)
    const key = state.hook!.queued.editor!.scopeKey
    const accepted = queuedMessageWithEdit(message.body, {
      text: '$review',
      skills: [{ name: 'review', path: '/A/SKILL.md' }],
      images: []
    })
    if (!accepted.ok) {
      throw new Error(accepted.reason)
    }
    act(() => state.hook!.queued.editor!.change('/rev'))
    act(() => state.menu!.onSelectionChange({ start: 4, end: 4 }))
    const row = state.menu!.rows.find(
      (entry) => entry.kind === 'skill' && entry.path === '/B/SKILL.md'
    )
    expect(row).toBeDefined()
    act(() => state.menu!.pick(row!))
    act(() => state.hook!.queued.editor!.change(`${state.hook!.queued.editor!.text}suffix`))
    act(() =>
      updateMobileNativeChatDraftInputs(key, (before) => ({
        ...before,
        images: [{ id: 'uploaded', path: '/new.png', previewUri: '/new.png' }]
      }))
    )
    const inputs = readMobileNativeChatDraftInputs(key)
    act(() => state.listener?.(batchEvent([{ ...message, body: accepted.body }])))
    expect(state.hook!.queued.editor).toMatchObject({
      scopeKey: key,
      text: '$review suffix',
      saving: false
    })
    expect(readMobileNativeChatDraftInputs(key)).toEqual(inputs)
    expect(state.bottomText).toBe('occupied')
    expect(resolved).not.toHaveBeenCalled()
    const holds = sendRequest.mock.calls
      .filter(
        ([method, params]) =>
          method === 'agentSession.queuedMessageEditHold' && fieldsOf(params).action === 'acquire'
      )
      .map(([, params]) => fieldsOf(params))
    expect(holds.at(-1)).toMatchObject({
      expectedBodyFingerprint: agentSessionSendBodyFingerprint(SESSION_ID, accepted.body)
    })
    expect(holds.at(-1)?.editId).not.toBe(holds.at(-2)?.editId)
    sendRequest.mockImplementation(async (method, params) =>
      method === 'agentSession.queuedMessageUpdate'
        ? mutationOk({
            status: 'updated',
            messageId: message.messageId,
            fingerprint: requestedFingerprint(message)
          })
        : readOrHoldReply(method, params)
    )
    await act(async () => {
      await state.hook!.queued.editor!.save()
    })
    const update = sendRequest.mock.calls.findLast(
      ([method]) => method === 'agentSession.queuedMessageUpdate'
    )
    expect(fieldsOf(update?.[1])).toMatchObject({
      text: '$review suffix',
      skills: [{ name: 'review', path: '/B/SKILL.md' }],
      images: [{ type: 'image-ref', path: '/new.png' }],
      expectedBodyFingerprint: agentSessionSendBodyFingerprint(SESSION_ID, accepted.body)
    })
    expect(state.hook!.queued.editor).toBeUndefined()
    expect(resolved).toHaveBeenCalledOnce()
    expect(state.bottomText).toBe('occupied')
  })
  it('hands back a full retained replacement and pending operations once with exact accepted-image exclusion', async () => {
    const message = queuedDraft({
      messageId: 'rebase-images',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'original' },
          { type: 'image-ref', path: '/original.png', alt: 'original' }
        ]
      }
    })
    await mount(message)
    act(() => state.hook!.queued.editor!.cancel())
    await act(async () =>
      state.renderer?.update(
        createElement(Harness, { imagesSupport: true, composerScopeKey: 'original-bottom' })
      )
    )
    await act(async () => {
      await state.hook!.queued.edit!('rebase-images')
    })
    act(() => setMobileNativeChatDraftText('original-bottom', 'occupied'))
    const key = state.hook!.queued.editor!.scopeKey
    act(() => {
      state.hook!.queued.editor!.change('submitted')
      updateMobileNativeChatDraftInputs(key, (before) => ({
        ...before,
        images: [
          ...before.images,
          { id: 'uploaded', path: '/accepted.png', previewUri: '/accepted.png' }
        ]
      }))
    })
    let finish: ((response: RpcResponse) => void) | undefined
    sendRequest.mockImplementation((method, params) =>
      method === 'agentSession.queuedMessageUpdate'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve(readOrHoldReply(method, params))
    )
    let saving: Promise<boolean> | undefined
    act(() => {
      saving = state.hook!.queued.editor!.save()
    })
    const voice = state.hook!.queued.editor!.insertDictation!
    act(() => {
      voice('newer')
    })
    await act(async () => {
      finish!(
        mutationOk({
          status: 'updated',
          messageId: message.messageId,
          fingerprint: requestedFingerprint(message)
        })
      )
      await saving
    })
    expect(state.hook!.queued.editor).toMatchObject({ text: 'submitted newer', saving: false })
    expect(resolved).not.toHaveBeenCalled()
    const operation = mobileNativeChatDraftDestination(key)
    act(() =>
      updateMobileNativeChatDraftInputs(operation, (before) => ({
        ...before,
        images: [
          ...before.images.filter(({ id }) => id !== 'uploaded'),
          { id: 'uploaded', path: '/changed.png', previewUri: '/changed.png' }
        ],
        files: [{ id: 'file', name: 'report.txt', path: null, mime: 'text/plain', byteLength: 3 }],
        pending: 1
      }))
    )
    act(() => state.listener?.(batchEvent([])))
    expect(state.hook!.queued.editor).toBeUndefined()
    expect(state.bottomText).toBe('occupied\n\nsubmitted newer')
    expect(readMobileNativeChatDraftInputs('original-bottom')).toMatchObject({
      images: [{ id: 'uploaded', path: '/changed.png' }],
      pending: 1
    })
    act(() =>
      updateMobileNativeChatDraftInputs(operation, (before) => ({
        ...before,
        files: before.files.map((file) => ({ ...file, path: '/report.txt' })),
        pending: 0
      }))
    )
    act(() => {
      voice('newer')
      state.listener?.(batchEvent([]))
    })
    expect(state.bottomText).toBe('occupied\n\nsubmitted newer newer')
    expect(readMobileNativeChatDraftInputs('original-bottom').files).toMatchObject([
      { path: '/report.txt' }
    ])
    expect(notice).toHaveBeenCalledOnce()
  })
})
