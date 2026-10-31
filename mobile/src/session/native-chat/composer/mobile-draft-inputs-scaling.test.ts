import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobileNativeChatFileAttachments } from './use-mobile-native-chat-file-attachments'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'
import {
  useMobileNativeChatDraft,
  setMobileNativeChatDraftText,
  resetMobileNativeChatDraftStoreForTests
} from './mobile-native-chat-draft-store'
import {
  subscribeMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs,
  closeMobileNativeChatEditInputs,
  useMobileNativeChatDraftInputs
} from './mobile-native-chat-draft-inputs'

const picker = vi.hoisted(() => ({ pickFiles: vi.fn(), pickImages: vi.fn() }))
vi.mock('../../../platform/media-picker', () => ({ useMediaPicker: () => picker }))
afterEach(resetMobileNativeChatDraftStoreForTests)

it.each([20, 200])(
  'isolates mounted text, input, image and file consumers across %i other scopes',
  async (count) => {
    const scopes = [
      'own-host:target',
      ...Array.from({ length: count }, (_, i) => `other-host:${i}`)
    ]
    const own = scopes[0]
    const renders = scopes.map(() => ({ text: 0, input: 0, image: 0, file: 0 }))
    const values: {
      text: string
      pending: number
      images: readonly string[]
      files: readonly string[]
    }[] = scopes.map(() => ({ text: '', pending: 0, images: [], files: [] }))
    const upstream = scopes.map(() => vi.fn())
    const releases = scopes.map((scope, i) =>
      subscribeMobileNativeChatDraftInputs(scope, upstream[i])
    )
    function Text({ index }: { index: number }) {
      values[index].text = useMobileNativeChatDraft(scopes[index])
      renders[index].text++
      return null
    }
    function Input({ index }: { index: number }) {
      values[index].pending = useMobileNativeChatDraftInputs(scopes[index]).pending ?? 0
      renders[index].input++
      return null
    }
    function File({ index }: { index: number }) {
      const file = useMobileNativeChatFileAttachments({
        client: null,
        sessionId: null,
        scopeKey: scopes[index],
        enabled: false,
        showToast: vi.fn()
      })
      values[index].files = file.files.map((entry) => entry.path ?? '')
      renders[index].file++
      return null
    }
    function Image({ index }: { index: number }) {
      const image = useMobileNativeChatImageAttachments({
        client: null,
        agent: 'codex',
        activeHandleRef: { current: null },
        deviceTokenRef: { current: null },
        getActiveWorktreeConnectionId: async () => null,
        connState: 'disconnected',
        scopeKey: scopes[index],
        enabled: false,
        structuredNativeChat: true,
        showToast: vi.fn(),
        onSendError: vi.fn(),
        baseSend: async () => 'rejected',
        readSeededLaunchDraft: () => null
      })
      values[index].images = image.attachments.map((entry) => entry.path)
      renders[index].image++
      return null
    }
    let view: ReturnType<typeof create> | undefined
    await act(async () => {
      view = create(
        createElement(
          'fixture',
          {},
          scopes.flatMap((_, index) => [
            createElement(Text, { key: `t${index}`, index }),
            createElement(Input, { key: `p${index}`, index }),
            createElement(File, { key: `f${index}`, index }),
            createElement(Image, { key: `i${index}`, index })
          ])
        )
      )
    })
    renders.forEach((entry) => {
      entry.text = entry.input = entry.image = entry.file = 0
    })
    try {
      await act(async () => setMobileNativeChatDraftText(own, 'own text'))
      expect(values[0].text).toBe('own text')
      expect(renders[0]).toEqual({ text: 1, input: 0, image: 0, file: 0 })
      await act(async () =>
        updateMobileNativeChatDraftInputs(own, (current) => ({ ...current, pending: 1 }))
      )
      expect(values[0].pending).toBe(1)
      await act(async () =>
        updateMobileNativeChatDraftInputs(own, (current) => ({
          ...current,
          images: [{ id: 'image', path: '/saved.png', previewUri: 'file:///saved.png' }]
        }))
      )
      expect(values[0].images).toEqual(['/saved.png'])
      await act(async () =>
        updateMobileNativeChatDraftInputs(own, (current) => ({
          ...current,
          files: [
            { id: 'file', path: '/saved.txt', name: 'saved.txt', mime: 'text/plain', byteLength: 1 }
          ]
        }))
      )
      expect(values[0].files).toEqual(['/saved.txt'])
      expect(renders[0]).toEqual({ text: 1, input: 3, image: 2, file: 1 })
      expect(upstream[0]).toHaveBeenCalledTimes(3)
      for (let index = 1; index < scopes.length; index++) {
        expect(renders[index]).toEqual({ text: 0, input: 0, image: 0, file: 0 })
        expect(upstream[index]).not.toHaveBeenCalled()
      }
    } finally {
      await act(async () => view?.unmount())
      releases.forEach((release) => release())
    }
    await act(async () =>
      updateMobileNativeChatDraftInputs(own, (current) => ({ ...current, pending: 0 }))
    )
    expect(renders[0]).toEqual({ text: 1, input: 3, image: 2, file: 1 })
    expect(upstream[0]).toHaveBeenCalledTimes(3)
  }
)
it.each([20, 200])(
  'notifies only affected scopes across %i retained input subscribers and retires listeners',
  (count) => {
    const idle = vi.fn()
    const releases = Array.from({ length: count }, (_, index) =>
      subscribeMobileNativeChatDraftInputs(`idle-${index}`, idle)
    )
    const source = vi.fn()
    const destination = vi.fn()
    releases.push(
      subscribeMobileNativeChatDraftInputs('queued-edit:one', source),
      subscribeMobileNativeChatDraftInputs('bottom', destination)
    )
    updateMobileNativeChatDraftInputs('queued-edit:one', (inputs) => ({ ...inputs, pending: 1 }))
    expect(source).toHaveBeenCalledTimes(1)
    expect(idle).not.toHaveBeenCalled()
    closeMobileNativeChatEditInputs('queued-edit:one', 'bottom')
    expect(source).toHaveBeenCalledTimes(2)
    expect(destination).toHaveBeenCalledTimes(1)
    expect(idle).not.toHaveBeenCalled()
    releases.forEach((release) => release())
    updateMobileNativeChatDraftInputs('bottom', (inputs) => ({ ...inputs, pending: 0 }))
    expect(destination).toHaveBeenCalledTimes(1)
  }
)
