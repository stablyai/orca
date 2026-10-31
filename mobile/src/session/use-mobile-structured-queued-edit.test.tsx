import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session-wire'
import type { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useMobileNativeChatSessionLane } from './use-mobile-native-chat-session-lane'
import type { RpcClient } from '../transport/rpc-client'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionSendBodyFingerprint } from '../../../src/shared/structured-agent-session-send-mutation'
import { queuedMessageWithEdit } from '../../../src/shared/queued-message-edit'
import type { RpcResponse } from '../transport/types'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import {
  mobileNativeChatDraftDestination,
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import {
  closeMobileNativeChatTabDraft,
  setMobileNativeChatDraftText,
  useMobileNativeChatDraft,
  resetMobileNativeChatDraftStoreForTests
} from './native-chat/composer/mobile-native-chat-draft-store'
import {
  CAPABLE,
  SESSION_ID,
  batchEvent,
  fieldsOf,
  mutationOk,
  ok,
  queuedDraft,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'
import {
  editHoldReply,
  mobileQueuedEditHarness,
  withText,
  readOrHoldReply,
  registerQueuedCanonicalInputTest
} from './mobile-queued-edit-hook.test-fixture'
import { insertDictationText } from '../dictation/mobile-dictation-text-insertion'

// What the composer hands the editor for words said into a field that was never focused.
const spoken = (text: string) => (draft: string) => insertDictationText(draft, text, null).text

describe('mobile in-place queued Edit', () => {
  const rig = mobileQueuedEditHarness()
  registerQueuedCanonicalInputTest(rig)
  const {
    state,
    Harness,
    mount,
    client,
    sendRequest,
    append,
    error,
    notice,
    resolved,
    requestedFingerprint
  } = rig
  it('waits for the capability probe before offering the legacy fallback', async () => {
    await mount(queuedDraft({ messageId: 'draft-1' }), null)
    expect(state.hook!.queued.edit).toBeUndefined()
    expect(
      sendRequest.mock.calls.some(
        ([method]) =>
          method === 'agentSession.queuedMessageDelete' ||
          method === 'agentSession.queuedMessageEditHold'
      )
    ).toBe(false)
    await act(async () => state.renderer?.update(createElement(Harness, { editSupport: false })))
    expect(state.hook!.queued.edit).toEqual(expect.any(Function))
  })

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true]
  ])(
    'sends own optional keys only for host image=%s skill=%s capabilities',
    async (imagesSupport, skillsSupport) => {
      const message = queuedDraft({
        messageId: 'matrix',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [
            { type: 'text', text: '$review original' },
            {
              type: 'image-ref',
              path: '/host/original.png',
              alt: 'original'
            }
          ],
          skills: [{ name: 'review', path: '/host/old/SKILL.md' }]
        }
      })
      await mount(message)
      act(() => state.hook!.queued.editor!.cancel())
      await act(async () =>
        state.renderer!.update(createElement(Harness, { imagesSupport, skillsSupport }))
      )
      await act(async () => {
        await state.hook!.queued.edit!('matrix')
      })
      act(() => state.hook!.queued.editor!.change('$review changed'))
      await act(async () => {
        expect(await state.hook!.queued.editor!.save()).toBe(true)
      })
      const request = fieldsOf(
        sendRequest.mock.calls.find(
          ([method]) => method === 'agentSession.queuedMessageUpdate'
        )?.[1]
      )
      expect(Object.hasOwn(request, 'images')).toBe(imagesSupport)
      expect(Object.hasOwn(request, 'skills')).toBe(skillsSupport)
      if (imagesSupport) {
        expect(request.images).toEqual([message.body.blocks[1]])
      }
      if (skillsSupport) {
        expect(request.skills).toEqual(message.body.skills)
      }
      // The old-host path leaves image blocks on the host while changing only text.
      const edited = queuedMessageWithEdit(message.body, {
        text: String(request.text),
        ...(imagesSupport
          ? {
              images: [
                {
                  type: 'image-ref' as const,
                  path: '/host/original.png',
                  alt: 'original'
                }
              ]
            }
          : {}),
        ...(skillsSupport ? { skills: message.body.skills } : {})
      })
      expect(edited.ok && edited.body.blocks.filter((block) => block.type === 'image-ref')).toEqual(
        [message.body.blocks[1]]
      )
    }
  )

  it.each([false, true])(
    'clean departure redirects captured dictation and Cancel=%s retires it',
    async (cancel) => {
      await mount(queuedDraft({ messageId: 'clean-dictation' }))
      act(() => state.hook!.queued.editor!.cancel())
      await act(async () =>
        state.renderer!.update(createElement(Harness, { composerScopeKey: 'original-bottom' }))
      )
      await act(async () => {
        await state.hook!.queued.edit!('clean-dictation')
      })
      const insert = state.hook!.queued.editor!.insertDictation!
      if (cancel) {
        act(() => state.hook!.queued.editor!.cancel())
      } else {
        await act(async () =>
          state.renderer!.update(
            createElement(Harness, { sessionId: 'elsewhere', composerScopeKey: 'elsewhere' })
          )
        )
      }
      act(() => setMobileNativeChatDraftText('original-bottom', 'bottom'))
      act(() => expect(insert(spoken('later'))).toBe(!cancel))
      expect(state.bottomText).toBe(cancel ? 'bottom' : 'bottom later')
    }
  )

  it('does not revive a closed tab when its dirty queued editor hands back late', async () => {
    const message = queuedDraft({ messageId: 'closed-origin' })
    await mount(message)
    act(() => state.hook!.queued.editor!.cancel())
    await act(async () =>
      state.renderer!.update(createElement(Harness, { composerScopeKey: 'original-bottom' }))
    )
    await act(async () => {
      await state.hook!.queued.edit!(message.messageId)
    })
    const origin = mobileNativeChatDraftDestination('original-bottom')
    act(() => {
      state.hook!.queued.editor!.change('late dirty edit')
      closeMobileNativeChatTabDraft('original-bottom')
    })
    await act(async () =>
      state.renderer!.update(
        createElement(Harness, { sessionId: 'elsewhere', composerScopeKey: 'elsewhere' })
      )
    )
    expect(origin.active).toBe(false)
    expect(state.bottomText).toBe('')
    expect(append).not.toHaveBeenCalled()
    expect(notice).not.toHaveBeenCalled()
    expect(readMobileNativeChatDraftInputs('original-bottom').images).toEqual([])
  })

  it('holds and renews a card while typing, sends only its edited text, and cancels in place', async () => {
    const message = queuedDraft({
      messageId: 'image-card',
      position: 7,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'original' },
          { type: 'image-ref', path: '/images/snapshot.png' }
        ]
      }
    })
    vi.useFakeTimers()
    await mount(message)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    const holdCalls = () =>
      sendRequest.mock.calls.filter(([method]) => method === 'agentSession.queuedMessageEditHold')
    const acquire = fieldsOf(holdCalls()[0]?.[1])
    expect(acquire).toMatchObject({
      sessionId: SESSION_ID,
      messageId: 'image-card',
      action: 'acquire',
      expectedBodyFingerprint: agentSessionSendBodyFingerprint(SESSION_ID, message.body)
    })
    expect(fieldsOf(holdCalls()[1]?.[1])).toMatchObject({ action: 'renew', editId: acquire.editId })
    act(() => state.hook!.queued.editor!.change('edited'))
    await act(async () => {
      expect(await state.hook!.queued.editor!.save()).toBe(true)
    })
    const update = sendRequest.mock.calls.find(
      ([method]) => method === 'agentSession.queuedMessageUpdate'
    )
    expect(fieldsOf(update?.[1])).toMatchObject({
      messageId: 'image-card',
      text: 'edited',
      expectedBodyFingerprint: acquire.expectedBodyFingerprint
    })
    expect(fieldsOf(update?.[1])).not.toHaveProperty('body')
    const body = withText(message.body, 'edited')
    act(() => state.listener?.(batchEvent([{ ...message, body }])))
    expect(state.hook!.queued.cards).toMatchObject([{ messageId: 'image-card', text: 'edited' }])
    expect(state.hook!.queued.editor).toBeUndefined()
    expect(fieldsOf(holdCalls().at(-1)?.[1])).toMatchObject({
      action: 'release',
      editId: acquire.editId
    })
    await act(async () => {
      await state.hook!.queued.edit!('image-card')
    })
    act(() => state.hook!.queued.editor!.change('cancelled'))
    await act(async () => state.hook!.queued.editor!.cancel())
    expect(state.hook!.queued.cards[0]?.text).toBe('edited')
    expect(
      sendRequest.mock.calls.some(([method]) => method === 'agentSession.queuedMessageDelete')
    ).toBe(false)
    expect(append).not.toHaveBeenCalled()
  })

  it('hands a conflicted edit back once and reconciles a lost reply from the published desired body', async () => {
    const message = queuedDraft({ messageId: 'draft-1' })
    await mount(message)
    const newer = withText(message.body, 'edited elsewhere')
    sendRequest.mockImplementation(async (method, params) => {
      if (method !== 'agentSession.queuedMessageUpdate') {
        return readOrHoldReply(method, params)
      }
      state.listener?.(batchEvent([{ ...message, body: newer }]))
      return mutationOk({ status: 'changed', messageId: 'draft-1' })
    })
    act(() => state.hook!.queued.editor!.change('my text'))
    await act(async () => {
      expect(await state.hook!.queued.editor!.save()).toBe(false)
    })
    expect(append).toHaveBeenCalledExactlyOnceWith('my text')
    expect(notice).toHaveBeenCalledExactlyOnceWith('Your edit is in the chat box.')
    expect(state.hook!.queued.editor).toBeUndefined()
    await act(async () => {
      await state.hook!.queued.edit!('draft-1')
    })
    act(() => state.hook!.queued.editor!.change('saved text'))
    const body = withText(message.body, 'saved text')
    sendRequest.mockImplementation(async (method, params) => {
      if (method === 'agentSession.queuedMessageUpdate') {
        state.listener?.(batchEvent([{ ...message, body }]))
        throw markRpcDeliveryUnknown(new Error('reply lost'))
      }
      return readOrHoldReply(method, params)
    })
    await act(async () => {
      await state.hook!.queued.editor!.save()
    })
    expect(state.hook!.queued.editor).toBeUndefined()
    expect(state.hook!.queued.cards[0]?.text).toBe('saved text')
    expect(error).not.toHaveBeenCalled()
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('preserves typing made after an unknown result when delayed proof arrives', async () => {
    const message = queuedDraft({ messageId: 'late-proof' })
    await mount(message)
    sendRequest.mockImplementation(async (method, params) => {
      if (method === 'agentSession.queuedMessageUpdate') {
        throw markRpcDeliveryUnknown(new Error('lost'))
      }
      return readOrHoldReply(method, params)
    })
    act(() => state.hook!.queued.editor!.change('submitted'))
    await act(async () => {
      await state.hook!.queued.editor!.save()
    })
    act(() => state.hook!.queued.editor!.change('submitted plus unsaved'))
    act(() =>
      state.listener?.(batchEvent([{ ...message, body: withText(message.body, 'submitted') }]))
    )
    expect(state.hook!.queued.editor).toMatchObject({
      text: 'submitted plus unsaved',
      saving: false
    })
    expect(append).not.toHaveBeenCalled()
    expect(resolved).not.toHaveBeenCalled()
  })

  it.each(['updated', 'not-editable'] as const)(
    'retains dictation during a deferred %s Save and after success',
    async (status) => {
      const message = queuedDraft({ messageId: 'dictation-save' })
      await mount(message)
      act(() => state.hook!.queued.editor!.cancel())
      await act(async () =>
        state.renderer?.update(createElement(Harness, { composerScopeKey: 'original-bottom' }))
      )
      await act(async () => {
        await state.hook!.queued.edit!(message.messageId)
      })
      let reply: ((response: RpcResponse) => void) | undefined
      sendRequest.mockImplementation((method, params) =>
        method === 'agentSession.queuedMessageUpdate'
          ? new Promise((resolve) => {
              reply = resolve
            })
          : Promise.resolve(readOrHoldReply(method, params))
      )
      act(() => state.hook!.queued.editor!.change('submitted'))
      const insert = state.hook!.queued.editor!.insertDictation!
      let saving: Promise<boolean> | undefined
      act(() => {
        saving = state.hook!.queued.editor!.save()
      })
      act(() => {
        expect(insert(spoken('speech'))).toBe(true)
      })
      await act(async () => {
        reply!(mutationOk({ status, messageId: message.messageId }))
        await saving
      })
      if (status === 'updated') {
        expect(state.bottomText).toBe('')
        expect(state.hook!.queued.editor!.text).toBe('submitted speech')
        act(() => {
          expect(insert(spoken('later'))).toBe(true)
        })
        expect(state.bottomText).toBe('')
        expect(state.hook!.queued.editor!.text).toBe('submitted speech later')
      } else {
        expect(state.hook!.queued.editor!.text).toBe('submitted speech')
      }
    }
  )

  it('preserves unsaved typing once and releases the hold when changing chats', async () => {
    await mount(queuedDraft({ messageId: 'draft-1' }))
    act(() => state.hook!.queued.editor!.change('unsaved'))
    await act(async () =>
      state.renderer?.update(createElement(Harness, { sessionId: 'other-chat' }))
    )
    expect(append).toHaveBeenCalledExactlyOnceWith('unsaved')
    expect(notice).toHaveBeenCalledOnce()
    expect(state.hook!.queued.editor).toBeUndefined()
    expect(
      sendRequest.mock.calls
        .filter(([method]) => method === 'agentSession.queuedMessageEditHold')
        .map(([, params]) => fieldsOf(params).action)
    ).toEqual(['acquire', 'release'])
  })

  it.each(['updated', 'changed'] as const)(
    'lets the submitted snapshot own a deferred %s reply after leaving the chat',
    async (status) => {
      const message = queuedDraft({ messageId: 'deferred-card' })
      await mount(message)
      let answer: ((response: RpcResponse) => void) | undefined
      sendRequest.mockImplementation((method, params) =>
        method === 'agentSession.queuedMessageUpdate'
          ? new Promise<RpcResponse>((resolve) => {
              answer = resolve
            })
          : Promise.resolve(readOrHoldReply(method, params))
      )
      act(() => state.hook!.queued.editor!.change('edited in place'))
      let save: Promise<boolean> | undefined
      act(() => {
        save = state.hook!.queued.editor!.save()
      })
      expect(state.hook!.queued.editor!.saving).toBe(true)
      await act(async () =>
        state.renderer?.update(createElement(Harness, { sessionId: 'other-chat' }))
      )
      expect(append).not.toHaveBeenCalled()
      await act(async () => {
        answer?.(
          mutationOk({
            status,
            messageId: message.messageId,
            fingerprint: requestedFingerprint(message)
          })
        )
        await save
      })
      if (status === 'changed') {
        expect(append).toHaveBeenCalledExactlyOnceWith('edited in place')
        expect(notice).toHaveBeenCalledOnce()
      } else {
        expect(append).not.toHaveBeenCalled()
        expect(notice).not.toHaveBeenCalled()
      }
      expect(error).not.toHaveBeenCalled()
      expect(resolved).not.toHaveBeenCalled()
      expect(state.hook!.queued.editor).toBeUndefined()
    }
  )

  it('leaves a disappeared card to its in-flight Save and returns a refused submitted draft once', async () => {
    const message = queuedDraft({ messageId: 'lost-reply-card' })
    await mount(message)
    let answer: ((response: RpcResponse) => void) | undefined
    sendRequest.mockImplementation((method, params) =>
      method === 'agentSession.queuedMessageUpdate'
        ? new Promise<RpcResponse>((resolve) => {
            answer = resolve
          })
        : Promise.resolve(readOrHoldReply(method, params))
    )
    act(() => state.hook!.queued.editor!.change('submitted edit'))
    let save: Promise<boolean> | undefined
    act(() => {
      save = state.hook!.queued.editor!.save()
    })
    act(() => state.listener?.(batchEvent([])))
    expect(state.hook!.queued.editor?.saving).toBe(true)
    expect(append).not.toHaveBeenCalled()
    await act(async () => {
      answer?.(
        ok({
          ok: false,
          refusal: { code: 'agent_session_operation_invalid', message: 'Could not edit.' }
        })
      )
      expect(await save).toBe(false)
    })
    expect(state.hook!.queued.editor).toBeUndefined()
    expect(append).toHaveBeenCalledExactlyOnceWith('submitted edit')
    expect(notice).toHaveBeenCalledOnce()
  })

  it('keeps a refused Save in the editor and closes only when the published card is gone', async () => {
    const message = queuedDraft({ messageId: 'refused-card' })
    await mount(message)
    sendRequest.mockImplementation(async (method, params) =>
      method === 'agentSession.queuedMessageUpdate'
        ? ok({
            ok: false,
            refusal: { code: 'agent_session_operation_invalid', message: 'Could not edit.' }
          })
        : readOrHoldReply(method, params)
    )
    act(() => state.hook!.queued.editor!.change('keep this text'))
    await act(async () => {
      expect(await state.hook!.queued.editor!.save()).toBe(false)
    })
    expect(state.hook!.queued.editor?.text).toBe('keep this text')
    expect(state.hook!.queued.editor?.saving).toBe(false)
    expect(error).toHaveBeenCalledTimes(1)
    expect(append).not.toHaveBeenCalled()
    act(() => state.listener?.(batchEvent([])))
    expect(state.hook!.queued.editor).toBeUndefined()
  })

  it('keeps exact typing through disconnect and reacquires the hold on the replacement transport', async () => {
    vi.useFakeTimers()
    await mount(queuedDraft({ messageId: 'reconnect-card' }))
    const text = 'unsaved text\nwith spacing  and 🐈'
    act(() => state.hook!.queued.editor!.change(text))
    await act(async () =>
      state.renderer?.update(createElement(Harness, { connected: false, transport: null }))
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(state.hook!.queued.editor?.text).toBe(text)
    const reconnectedRequest = vi.fn<RpcClient['sendRequest']>(async (method, params) =>
      method === 'agentSession.queuedMessageEditHold'
        ? fieldsOf(params).action === 'renew'
          ? ok({ status: 'expired' })
          : editHoldReply(params)
        : ok({ models: [], current: {} })
    )
    await act(async () =>
      state.renderer?.update(
        createElement(Harness, { transport: { ...client, sendRequest: reconnectedRequest } })
      )
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(state.hook!.queued.editor?.text).toBe(text)
    expect(
      reconnectedRequest.mock.calls
        .filter(([method]) => method === 'agentSession.queuedMessageEditHold')
        .map(([, params]) => fieldsOf(params).action)
    ).toEqual(['renew', 'acquire'])
    expect(error).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    await act(async () => state.hook!.queued.editor!.cancel())
    await act(async () =>
      state.renderer?.update(createElement(Harness, { connected: false, transport: null }))
    )
    const calls = reconnectedRequest.mock.calls.length
    await act(async () => {
      expect(await state.hook!.queued.edit!('reconnect-card')).toBe(false)
    })
    expect(error).toHaveBeenCalledExactlyOnceWith('Reconnect to edit.')
    expect(state.hook!.queued.editor).toBeUndefined()
    expect(reconnectedRequest).toHaveBeenCalledTimes(calls)
  })

  it('returns skills, new images, files and pending work into the original non-empty draft on involuntary close', async () => {
    const message = queuedDraft({
      messageId: 'full-draft',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: '$review original' },
          { type: 'image-ref', path: '/original.png' }
        ],
        skills: [{ name: 'review', path: '/remote/SKILL.md' }]
      }
    })
    await mount(message)
    act(() => state.hook!.queued.editor!.cancel())
    await act(async () =>
      state.renderer?.update(
        createElement(Harness, {
          composerScopeKey: 'original-bottom',
          imagesSupport: true,
          skillsSupport: true
        })
      )
    )
    await act(async () => {
      await state.hook!.queued.edit!(message.messageId)
    })
    const scope = state.hook!.queued.editor!.scopeKey
    const operation = mobileNativeChatDraftDestination(scope)
    act(() => {
      setMobileNativeChatDraftText('original-bottom', 'already typed')
      state.hook!.queued.editor!.change('$review changed')
      updateMobileNativeChatDraftInputs(scope, (current) => ({
        ...current,
        pending: 1,
        images: [
          ...current.images,
          { id: 'new-image', path: '/new.png', previewUri: 'file:///new.png' }
        ],
        files: [{ id: 'file', name: 'report.txt', path: null, mime: 'text/plain', byteLength: 10 }]
      }))
    })
    expect(state.hook!.queued.editor!.canSave).toBe(false)
    act(() => state.listener?.(batchEvent([])))
    expect(state.hook!.queued.editor).toBeUndefined()
    expect(state.bottomText).toBe('already typed\n\n$review changed')
    expect(readMobileNativeChatDraftInputs('original-bottom')).toMatchObject({
      skills: message.body.skills,
      images: [{ id: 'new-image' }],
      files: [{ id: 'file', path: null }],
      pending: 1
    })
    act(() =>
      updateMobileNativeChatDraftInputs(operation, (current) => ({
        ...current,
        pending: 0,
        files: current.files.map((file) => ({ ...file, path: '/stored/report.txt' }))
      }))
    )
    expect(readMobileNativeChatDraftInputs('original-bottom').files[0]?.path).toBe(
      '/stored/report.txt'
    )
    expect(readMobileNativeChatDraftInputs(scope).images).toEqual([])
    expect(notice).toHaveBeenCalledOnce()
    expect(error).not.toHaveBeenCalled()
  })

  it('submits Save while hold acquisition is still pending', async () => {
    const message = queuedDraft({ messageId: 'save-before-hold' })
    await mount(message)
    act(() => state.hook!.queued.editor!.cancel())
    let answerHold: ((response: RpcResponse) => void) | undefined
    sendRequest.mockImplementation((method, params) =>
      method === 'agentSession.queuedMessageEditHold' && fieldsOf(params).action === 'acquire'
        ? new Promise<RpcResponse>((resolve) => {
            answerHold = resolve
          })
        : method === 'agentSession.queuedMessageEditHold'
          ? Promise.resolve(readOrHoldReply(method, params))
          : Promise.resolve(
              mutationOk({
                status: 'updated',
                messageId: message.messageId,
                fingerprint: requestedFingerprint(message)
              })
            )
    )
    await act(async () => {
      await state.hook!.queued.edit!(message.messageId)
    })
    act(() => state.hook!.queued.editor!.change('saved without hold reply'))
    await act(async () => {
      expect(await state.hook!.queued.editor!.save()).toBe(true)
    })
    expect(state.hook!.queued.editor).toBeUndefined()
    expect(answerHold).toBeDefined()
    await act(async () => answerHold?.(editHoldReply({ action: 'acquire' })))
    expect(append).not.toHaveBeenCalled()
  })
})

vi.mock('./use-mobile-native-chat-session', () => ({ useMobileNativeChatSession: () => ({}) }))

describe('mobile queued Edit captured origin', () => {
  let renderer: ReactTestRenderer | undefined
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | undefined
  let listener: ((data: unknown) => void) | undefined
  const append = vi.fn(() => true)
  const appendRef: { current: (text: string) => boolean } = { current: append }
  let originDraft = ''
  let nextDraft = ''
  const error = vi.fn()
  const resolved = vi.fn()
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const client: RpcClient = {
    sendRequest,
    subscribe: (_method, _params, onData) => {
      listener = onData
      return () => {}
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  function Harness({
    sessionId = SESSION_ID,
    editSupport = true,
    enabled = true,
    connected = true,
    transport = client
  }: {
    sessionId?: string
    editSupport?: boolean | null
    enabled?: boolean
    connected?: boolean
    transport?: RpcClient | null
  }): null {
    hook = useMobileNativeChatSessionLane({
      client: transport,
      structured: true,
      hostId: 'host-a',
      resolution: {
        agent: 'codex',
        sessionId,
        transcriptPath: null,
        agentConfirmed: true,
        sessionLive: true
      },
      sourceIdentity: 'host-a',
      enabled,
      connState: connected ? 'connected' : 'disconnected',
      hostSupport:
        editSupport === null
          ? null
          : {
              ...CAPABLE,
              queuedMessages: false,
              queuedMessageEdit: editSupport
            },
      appendComposerTextRef: appendRef,
      onSendError: error,
      onActionResolved: resolved
    }).structuredSession
    originDraft = useMobileNativeChatDraft('origin')
    nextDraft = useMobileNativeChatDraft('next')
    return null
  }
  async function mount(message: AgentSessionQueuedMessage, editSupport: boolean | null = true) {
    vi.clearAllMocks()
    resetMobileNativeChatDraftStoreForTests()
    sendRequest.mockImplementation(async (method, params) =>
      method === 'agentSession.queuedMessageUpdate'
        ? mutationOk({
            status: 'updated',
            messageId: message.messageId,
            fingerprint: agentSessionSendBodyFingerprint(
              SESSION_ID,
              withText(message.body, 'typing at origin')
            )
          })
        : readOrHoldReply(method, params)
    )
    await act(async () => {
      renderer = create(createElement(Harness, { editSupport }))
    })
    act(() => listener?.(snapshotEvent({ queuedMessages: [message], runningTurn: true })))
    if (editSupport !== null) {
      await act(async () => {
        expect(await hook!.queued.edit!(message.messageId)).toBe(true)
      })
    }
  }
  afterEach(async () => {
    await act(async () => renderer?.unmount())
    vi.useRealTimers()
    appendRef.current = append
  })

  it.each(['navigate', 'accepted-save', 'failed-save'] as const)(
    'keeps dirty input with the captured origin through %s',
    async (mode) => {
      const message = queuedDraft({ messageId: 'origin-edit' })
      appendRef.current = (text) => {
        setMobileNativeChatDraftText('origin', (old) => `${old}${text}`)
        return true
      }
      await mount(message)
      act(() => hook!.queued.editor!.change('typing at origin'))
      const answer = Promise.withResolvers<RpcResponse>()
      let saving: Promise<boolean> | undefined
      if (mode !== 'navigate') {
        sendRequest.mockImplementationOnce(() => answer.promise)
        act(() => {
          saving = hook!.queued.editor!.save()
        })
      }
      appendRef.current = (text) => {
        setMobileNativeChatDraftText('next', (old) => `${old}${text}`)
        return true
      }
      await act(async () => renderer?.update(createElement(Harness, { sessionId: 'next-session' })))
      if (saving) {
        await act(async () => {
          answer.resolve(
            mode === 'accepted-save'
              ? mutationOk({
                  status: 'updated',
                  messageId: message.messageId,
                  fingerprint: agentSessionSendBodyFingerprint(
                    SESSION_ID,
                    withText(message.body, 'typing at origin')
                  )
                })
              : mutationOk({ status: 'gone' })
          )
          await saving
        })
      }
      expect(originDraft).toBe(mode === 'accepted-save' ? '' : 'typing at origin')
      expect(nextDraft).toBe('')
      await act(async () => renderer?.unmount())
      renderer = undefined
      setMobileNativeChatDraftText('origin', '')
    }
  )
})
