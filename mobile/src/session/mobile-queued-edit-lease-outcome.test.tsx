import { createElement } from 'react'
import { setMobileNativeChatDraftText } from './native-chat/composer/mobile-native-chat-draft-store'
import {
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import { act } from 'react-test-renderer'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { QueuedEditHostFixtureModule } from '../../../src/shared/queued-edit-host.test-fixture'
import type { AgentSessionQueuedMessageEditHoldResult } from '../../../src/shared/agent-session-wire'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { mobileQueuedEditHarness, readOrHoldReply } from './mobile-queued-edit-hook.test-fixture'
import {
  fieldsOf,
  mutationOk,
  ok,
  queuedDraft,
  SESSION_ID
} from './use-mobile-structured-agent-session-queued.test-fixture'
import { insertDictationText } from '../dictation/mobile-dictation-text-insertion'

// What the composer hands the editor for words said into a field that was never focused.
const spoken = (text: string) => (draft: string) => insertDictationText(draft, text, null).text

let queuedEditHost: QueuedEditHostFixtureModule['queuedEditHost']
beforeAll(async () => {
  const fixtures = await vi.importActual<QueuedEditHostFixtureModule>(
    '../../../src/main/native-chat/agent-session-journal/queued-edit-host.test-fixture'
  )
  queuedEditHost = fixtures.queuedEditHost
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('mobile current acquisition belongs to the Save outcome owner', () => {
  const { state, Harness, mount, sendRequest, notice, append, resolved } = mobileQueuedEditHarness()
  it.each([
    'updated',
    'unchanged',
    'newer',
    'fresh-loss',
    'gone',
    'refused',
    'unknown',
    'late-unknown',
    'unresolved',
    'depart',
    'depart-equal'
  ] as const)(
    '%s does not return accepted current input before the delayed result',
    async (mode) => {
      const message = queuedDraft({ messageId: 'lease-race' })
      const host = queuedEditHost(SESSION_ID, message)
      await mount(message)
      act(() => state.hook!.queued.editor!.cancel())
      const loss = deferred<AgentSessionQueuedMessageEditHoldResult>()
      const freshLoss = deferred<AgentSessionQueuedMessageEditHoldResult>()
      const release = deferred<void>()
      let expected = ''
      let editId = ''
      let acquires = 0
      sendRequest.mockImplementation(async (method, params) => {
        const fields = fieldsOf(params)
        if (method === 'agentSession.queuedMessageEditHold' && fields.action === 'acquire') {
          acquires++
          expected = String(fields.expectedBodyFingerprint)
          editId = String(fields.editId)
          return ok(
            acquires === 1
              ? await loss.promise
              : mode === 'fresh-loss'
                ? await freshLoss.promise
                : host.acquire(editId, expected)
          )
        }
        if (method !== 'agentSession.queuedMessageUpdate') {
          return readOrHoldReply(method, params)
        }
        await release.promise
        if (mode === 'unknown' || mode === 'late-unknown') {
          throw markRpcDeliveryUnknown(new Error('lost'))
        }
        return mutationOk(
          mode === 'refused' ? { status: 'not-editable', messageId: message.messageId } : decision
        )
      })
      await act(async () => {
        await state.hook!.queued.edit!(message.messageId)
      })
      act(() => state.hook!.queued.editor!.change('B'))
      if (mode === 'unchanged') {
        host.update({
          messageId: message.messageId,
          expectedBodyFingerprint: host.row!.fingerprint,
          text: 'B'
        })
      }
      let save!: Promise<boolean>
      act(() => {
        save = state.hook!.queued.editor!.save()
      })
      const decision = host.update({
        messageId: message.messageId,
        expectedBodyFingerprint: expected,
        text: 'B'
      })
      expect(decision.status).toBe(mode === 'unchanged' ? 'unchanged' : 'updated')
      if (mode === 'newer' || mode === 'fresh-loss' || mode === 'gone' || mode === 'depart') {
        act(() => {
          state.hook!.queued.editor!.insertDictation!(spoken('C'))
        })
      }
      if (mode === 'gone') {
        host.depart()
      }
      const negative = host.acquire(editId, expected)
      expect(negative.status).toBe(mode === 'gone' ? 'gone' : 'changed')
      if (mode === 'depart' || mode === 'depart-equal') {
        act(() => state.renderer!.unmount())
        state.renderer = undefined
      }
      if (mode !== 'late-unknown' && mode !== 'unresolved') {
        await act(async () => loss.resolve(negative))
        if (mode !== 'depart' && mode !== 'depart-equal') {
          expect(state.hook!.queued.editor?.saving).toBe(true)
        }
        expect(append).not.toHaveBeenCalled()
        expect(notice).not.toHaveBeenCalled()
      }
      await act(async () => {
        release.resolve()
        await save
      })
      if (mode === 'late-unknown') {
        expect(state.hook!.queued.editor).toMatchObject({ saving: false })
        await act(async () => loss.resolve(negative))
      }
      if (mode === 'newer' || mode === 'fresh-loss') {
        expect(state.hook!.queued.editor).toMatchObject({ text: 'B C', saving: false })
        expect(append).not.toHaveBeenCalled()
        expect(acquires).toBe(2)
        expect(resolved).not.toHaveBeenCalled()
        if (mode === 'fresh-loss') {
          host.depart()
          await act(async () => freshLoss.resolve(host.acquire(editId, expected)))
          expect(state.hook!.queued.editor).toBeUndefined()
          expect(append).toHaveBeenCalledWith('B C')
          expect(notice).toHaveBeenCalledOnce()
        } else {
          act(() => state.hook!.queued.editor!.cancel())
          expect(state.bottomText).toBe('')
        }
      } else if (
        mode === 'gone' ||
        mode === 'refused' ||
        mode === 'unknown' ||
        mode === 'late-unknown' ||
        mode === 'depart'
      ) {
        if (mode !== 'depart') {
          expect(state.hook!.queued.editor).toBeUndefined()
        }
        expect(append).toHaveBeenCalledOnce()
        expect(append).toHaveBeenCalledWith(mode === 'gone' || mode === 'depart' ? 'B C' : 'B')
        expect(notice).toHaveBeenCalledOnce()
      } else {
        if (mode !== 'depart-equal') {
          expect(state.hook!.queued.editor).toBeUndefined()
        }
        expect(append).not.toHaveBeenCalled()
        expect(notice).not.toHaveBeenCalled()
        if (mode !== 'depart-equal') {
          expect(resolved).toHaveBeenCalledOnce()
        }
      }
      if (mode === 'unresolved') {
        await act(async () => loss.resolve(negative))
      }
      expect(append).toHaveBeenCalledTimes(
        ['gone', 'refused', 'unknown', 'late-unknown', 'depart', 'fresh-loss'].includes(mode)
          ? 1
          : 0
      )
      host.leases.dispose()
    }
  )
  it.each(['unknown-changed', 'unknown-gone', 'pending-proof', 'rebase-loss'] as const)(
    '%s delivers timed terminal loss through the actual phone lease into its owner',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const message = queuedDraft({ messageId: 'timed' })
      const host = queuedEditHost(SESSION_ID, message)
      await mount(message)
      await act(async () => state.hook!.queued.editor!.cancel())
      const actions: string[] = []
      const reply = deferred<void>()
      let decision: ReturnType<typeof host.update>
      sendRequest.mockImplementation(async (method, params) => {
        if (method === 'agentSession.queuedMessageEditHold') {
          const fields = fieldsOf(params)
          const editId = String(fields.editId)
          const key = { callerKey: 'client', editId }
          actions.push(String(fields.action))
          if (fields.action === 'release') {
            host.leases.release(key, message.messageId)
            return ok({ status: 'released' })
          }
          return ok(
            fields.action === 'acquire'
              ? host.acquire(editId, String(fields.expectedBodyFingerprint))
              : host.leases.renew(key, message.messageId)
          )
        }
        if (method !== 'agentSession.queuedMessageUpdate') {
          return readOrHoldReply(method, params)
        }
        decision = host.update({
          messageId: message.messageId,
          expectedBodyFingerprint: host.row!.fingerprint,
          text: '$review B'
        })
        expect(decision.status).toBe('updated')
        await reply.promise
        if (mode.startsWith('unknown')) {
          throw markRpcDeliveryUnknown(new Error('lost'))
        }
        return mutationOk(decision)
      })
      await act(async () =>
        state.renderer!.update(
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
      act(() => setMobileNativeChatDraftText('original-bottom', 'occupied'))
      act(() => state.hook!.queued.editor!.change('$review B'))
      let save!: Promise<boolean>
      await act(async () => {
        save = state.hook!.queued.editor!.save()
      })
      const scope = state.hook!.queued.editor!.scopeKey
      if (mode === 'rebase-loss') {
        act(() => {
          state.hook!.queued.editor!.insertDictation!(spoken('C'))
          updateMobileNativeChatDraftInputs(scope, (input) => ({
            ...input,
            skills: [{ name: 'review', path: '/C/SKILL.md' }],
            images: [{ id: 'new-C', path: '/C.png', previewUri: 'file:///C.png' }]
          }))
        })
      }
      if (mode !== 'pending-proof') {
        await act(async () => {
          reply.resolve()
          await save
        })
      }
      if (mode === 'unknown-gone') {
        host.depart()
      }
      if (mode === 'rebase-loss') {
        expect(state.hook!.queued.editor).toMatchObject({ text: '$review B C', saving: false })
        expect(state.bottomText).toBe('occupied')
        expect(host.leases.heldIds()).toEqual(new Set([message.messageId]))
        host.update({
          messageId: message.messageId,
          expectedBodyFingerprint: host.row!.fingerprint,
          text: 'rival'
        })
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      if (mode === 'pending-proof') {
        expect(state.hook!.queued.editor?.saving).toBe(true)
        expect(notice).not.toHaveBeenCalled()
        expect(state.bottomText).toBe('occupied')
        await act(async () => {
          reply.resolve()
          await save
        })
      }
      expect(state.hook!.queued.editor).toBeUndefined()
      expect(state.bottomText).toBe(
        mode === 'pending-proof'
          ? 'occupied'
          : `occupied\n\n$review B${mode === 'rebase-loss' ? ' C' : ''}`
      )
      expect(notice).toHaveBeenCalledTimes(mode === 'pending-proof' ? 0 : 1)
      if (mode === 'rebase-loss') {
        expect(readMobileNativeChatDraftInputs('original-bottom')).toMatchObject({
          skills: [{ name: 'review', path: '/C/SKILL.md' }],
          images: [{ id: 'new-C', path: '/C.png' }]
        })
      }
      expect(actions).toEqual(
        mode === 'rebase-loss'
          ? ['acquire', 'acquire', 'release', 'renew', 'acquire', 'release']
          : ['acquire', 'renew', 'acquire', 'release']
      )
      const count = sendRequest.mock.calls.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000)
      })
      expect(sendRequest.mock.calls).toHaveLength(count)
      host.leases.dispose()
    }
  )

  it.each(['gone', 'held'] as const)(
    'initial phone transport failure then timed %s preserves owner outcomes',
    async (status) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const message = queuedDraft({ messageId: 'retry' })
      const host = queuedEditHost(SESSION_ID, message)
      await mount(message)
      act(() => state.hook!.queued.editor!.cancel())
      let first = true
      sendRequest.mockImplementation(async (method, params) => {
        const fields = fieldsOf(params)
        if (method !== 'agentSession.queuedMessageEditHold') {
          return readOrHoldReply(method, params)
        }
        if (fields.action === 'release') {
          return ok({ status: 'released' })
        }
        if (first) {
          first = false
          throw new Error('offline')
        }
        return ok(host.acquire(String(fields.editId), String(fields.expectedBodyFingerprint)))
      })
      await act(async () => {
        await state.hook!.queued.edit!(message.messageId)
      })
      act(() => state.hook!.queued.editor!.change('B'))
      if (status === 'gone') {
        host.depart()
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      if (status === 'gone') {
        expect(state.hook!.queued.editor).toBeUndefined()
        expect(append).toHaveBeenCalledOnce()
        expect(append).toHaveBeenCalledWith('B')
        expect(notice).toHaveBeenCalledOnce()
      } else {
        expect(state.hook!.queued.editor).toMatchObject({ text: 'B', saving: false })
        expect(append).not.toHaveBeenCalled()
        act(() => state.hook!.queued.editor!.cancel())
      }
      host.leases.dispose()
      warn.mockRestore()
    }
  )
})
