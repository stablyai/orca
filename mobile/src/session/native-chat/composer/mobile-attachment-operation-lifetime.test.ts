import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobileNativeChatFileAttachments } from './use-mobile-native-chat-file-attachments'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'
import {
  closeMobileNativeChatEditInputs,
  readMobileNativeChatDraftInputs,
  resetMobileNativeChatDraftInputsForTests
} from './mobile-native-chat-draft-inputs'
import type { RpcClient } from '../../../transport/rpc-client'
import type { RpcResponse } from '../../../transport/types'
const picker = vi.hoisted(() => ({ pickFiles: vi.fn(), pickImages: vi.fn() }))
vi.mock('../../../platform/media-picker', () => ({ useMediaPicker: () => picker }))
afterEach(() => resetMobileNativeChatDraftInputsForTests())

it.each(['files', 'images'] as const)(
  'retires remaining %s uploads on Cancel, and follows hand-back before the first chip',
  async (kind) => {
    for (const cancel of [true, false]) {
      let release = () => {}
      let started = () => {}
      const firstStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const starts: string[] = []
      const client: RpcClient = {
        sendRequest: vi.fn(async (method: string): Promise<RpcResponse> => {
          if (method.endsWith('uploadStart') || method === 'clipboard.startImageUpload') {
            starts.push(method)
            if (starts.length === 1) {
              started()
              await held
            }
            return {
              id: 'r',
              ok: true,
              result: { uploadId: `upload-${starts.length}` },
              _meta: { runtimeId: 'r' }
            }
          }
          const result =
            method === 'clipboard.commitImageUpload'
              ? `/stored/${starts.length}.png`
              : method.endsWith('uploadCommit')
                ? {
                    path: `/stored/${starts.length}.png`,
                    name: `${starts.length}.png`,
                    byteLength: 1
                  }
                : null
          return { id: 'r', ok: true, result, _meta: { runtimeId: 'r' } }
        }),
        subscribe: () => () => {},
        updateTerminalSubscriptionViewport: () => {},
        getState: () => 'connected',
        getReconnectAttempt: () => 0,
        getLastConnectedAt: () => null,
        onStateChange: () => () => {},
        notifyForeground: () => {},
        close: () => {}
      }
      picker.pickFiles.mockImplementation(async function* () {
        for (const name of ['a.txt', 'b.txt']) {
          yield { name, mime: 'text/plain', byteLength: 1, base64: 'YQ==' }
        }
      })
      picker.pickImages.mockResolvedValue([
        { base64: 'YQ==', uri: 'file:///a.png' },
        { base64: 'Yg==', uri: 'file:///b.png' }
      ])
      let attach = () => Promise.resolve()
      let send = () => Promise.resolve(false)
      const baseSend = vi.fn().mockResolvedValue('accepted')
      function Probe() {
        const file = useMobileNativeChatFileAttachments({
          client,
          sessionId: 's',
          scopeKey: 'edit',
          enabled: true,
          showToast: vi.fn()
        })
        const image = useMobileNativeChatImageAttachments({
          client,
          agent: 'codex',
          activeHandleRef: { current: null },
          deviceTokenRef: { current: null },
          getActiveWorktreeConnectionId: async () => null,
          connState: 'connected',
          scopeKey: 'edit',
          enabled: true,
          structuredNativeChat: true,
          showToast: vi.fn(),
          onSendError: vi.fn(),
          baseSend,
          readSeededLaunchDraft: () => null
        })
        attach = kind === 'files' ? file.attachFiles : () => image.attachImage('library')
        return null
      }
      let edit!: ReturnType<typeof create>
      await act(async () => {
        edit = create(createElement(Probe))
      })
      let work!: Promise<void>
      await act(async () => {
        work = attach()
        await firstStarted
      })
      act(() => closeMobileNativeChatEditInputs('edit', cancel ? undefined : 'bottom'))
      if (!cancel) {
        // Bottom Send must consume the transferred pending obligation even before a completed image exists.
        function Bottom() {
          const image = useMobileNativeChatImageAttachments({
            client,
            agent: 'codex',
            activeHandleRef: { current: null },
            deviceTokenRef: { current: null },
            getActiveWorktreeConnectionId: async () => null,
            connState: 'connected',
            scopeKey: 'bottom',
            enabled: true,
            structuredNativeChat: true,
            showToast: vi.fn(),
            onSendError: vi.fn(),
            baseSend,
            readSeededLaunchDraft: () => null
          })
          send = () => image.sendNativeChat('bottom')
          return null
        }
        let bottom!: ReturnType<typeof create>
        await act(async () => {
          bottom = create(createElement(Bottom))
        })
        await act(async () => expect(await send()).toBe(false))
        expect(baseSend).not.toHaveBeenCalled()
        act(() => bottom.unmount())
      }
      await act(async () => {
        release()
        await work
      })
      expect(starts).toHaveLength(cancel ? 1 : 2)
      const result = readMobileNativeChatDraftInputs('bottom')
      expect(result[kind]).toHaveLength(cancel ? 0 : 2)
      expect(result.pending ?? 0).toBe(0)
      act(() => edit.unmount())
      resetMobileNativeChatDraftInputsForTests()
    }
  }
)

it('retains unique image identity across a real hook remount and removes only the chosen photo', async () => {
  const client: RpcClient = {
    sendRequest: vi.fn(async (method: string): Promise<RpcResponse> => ({
      id: 'r',
      ok: true,
      result:
        method === 'clipboard.startImageUpload'
          ? { uploadId: 'upload' }
          : method === 'clipboard.commitImageUpload'
            ? '/stored/photo.png'
            : null,
      _meta: { runtimeId: 'r' }
    })),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  picker.pickImages.mockResolvedValue([{ base64: 'YQ==', uri: 'file:///photo.png' }])
  let hook!: ReturnType<typeof useMobileNativeChatImageAttachments>
  function Probe() {
    hook = useMobileNativeChatImageAttachments({
      client,
      agent: 'codex',
      activeHandleRef: { current: null },
      deviceTokenRef: { current: null },
      getActiveWorktreeConnectionId: async () => null,
      connState: 'connected',
      scopeKey: 'retained',
      enabled: true,
      structuredNativeChat: true,
      showToast: vi.fn(),
      onSendError: vi.fn(),
      baseSend: vi.fn().mockResolvedValue('accepted'),
      readSeededLaunchDraft: () => null
    })
    return null
  }
  let mounted!: ReturnType<typeof create>
  await act(async () => {
    mounted = create(createElement(Probe))
  })
  await act(async () => hook.attachImage('library'))
  const first = hook.attachments[0]!.id
  act(() => mounted.unmount())
  await act(async () => {
    mounted = create(createElement(Probe))
  })
  await act(async () => hook.attachImage('library'))
  const second = hook.attachments[1]!.id
  expect(second).not.toBe(first)
  act(() => hook.removeAttachment(second))
  expect(hook.attachments.map(({ id }) => id)).toEqual([first])
  act(() => mounted.unmount())
})
