import { createElement, Fragment } from 'react'
import type * as React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  resetMobileNativeChatDraftStoreForTests,
  setMobileNativeChatDraftText,
  useMobileNativeChatDraft
} from './native-chat/composer/mobile-native-chat-draft-store'
import {
  updateMobileNativeChatDraftInputs,
  type MobileNativeChatDraftInputs
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import { useMobileNativeChatDrafts } from './native-chat/composer/use-mobile-native-chat-drafts'
import { useMobileNativeChatFileAttachments } from './native-chat/composer/use-mobile-native-chat-file-attachments'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'
import { useMobileNativeChatImageAttachments } from './native-chat/composer/use-mobile-native-chat-image-attachments'
import type { MobileNativeChatSendOutcome } from './native-chat/mobile-native-chat-send'

const subscriptionWork = vi.hoisted(() => ({ active: 0, wakes: 0, snapshots: 0 }))
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof React>()
  type Subscribe = (listener: () => void) => () => void
  const observed = new WeakMap<Subscribe, Subscribe>()
  return {
    ...react,
    useSyncExternalStore<T>(subscribe: Subscribe, read: () => T, serverRead?: () => T): T {
      let subscribeObserved = observed.get(subscribe)
      if (!subscribeObserved) {
        subscribeObserved = (listener) => {
          subscriptionWork.active += 1
          const unsubscribe = subscribe(() => {
            subscriptionWork.wakes += 1
            listener()
          })
          return () => {
            subscriptionWork.active -= 1
            unsubscribe()
          }
        }
        observed.set(subscribe, subscribeObserved)
      }
      // Delegate selection, notification and equality to the real store and React.
      return react.useSyncExternalStore(
        subscribeObserved,
        () => {
          subscriptionWork.snapshots += 1
          return read()
        },
        serverRead
      )
    }
  }
})

vi.mock('../platform/media-picker', () => ({ useMediaPicker: () => ({ pickImages: vi.fn() }) }))
const SCOPE_A = 'h\0w\0tab-a'
type Hook = ReturnType<typeof useMobileNativeChatImageAttachments>
function updateImages(
  scope: string,
  update: (images: MobileNativeChatDraftInputs['images']) => MobileNativeChatDraftInputs['images']
) {
  updateMobileNativeChatDraftInputs(scope, (current) => ({
    ...current,
    images: update(current.images)
  }))
}
function updateFiles(
  scope: string,
  update: (files: MobileNativeChatDraftInputs['files']) => MobileNativeChatDraftInputs['files']
) {
  updateMobileNativeChatDraftInputs(scope, (current) => ({
    ...current,
    files: update(current.files)
  }))
}
let renderer: ReactTestRenderer | null = null
beforeEach(() => resetMobileNativeChatDraftStoreForTests())
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

it('returns refused text, images and files to their origin across teardown, retry and later acceptance', async () => {
  const client: RpcClient = {
    sendRequest: vi.fn(),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  let answer = Promise.withResolvers<MobileNativeChatSendOutcome>()
  const sendStructured = vi.fn(() => answer.promise)
  let full!: {
    drafts: ReturnType<typeof useMobileNativeChatDrafts> & { composerText: string }
    files: ReturnType<typeof useMobileNativeChatFileAttachments>
    images: Hook
    addImage: typeof updateImages
    addFile: typeof updateFiles
  }
  function Full({ tab }: { tab: string }): null {
    const scope = `h\0w\0${tab}`
    const drafts = useMobileNativeChatDrafts({
      hostId: 'h',
      worktreeId: 'w',
      tabId: tab,
      sessionId: tab,
      messages: [],
      transcriptSettled: true
    })
    const files = useMobileNativeChatFileAttachments({
      client,
      sessionId: tab,
      scopeKey: scope,
      enabled: true,
      showToast: () => {}
    })
    const bridge = useMobileStructuredNativeChatSendBridge({
      agent: 'codex',
      sendStructured,
      ...drafts,
      onSendError: () => {}
    })
    const images = useMobileNativeChatImageAttachments({
      client,
      agent: 'codex',
      enabled: true,
      deviceTokenRef: { current: null },
      getActiveWorktreeConnectionId: async () => null,
      connState: 'connected',
      showToast: () => {},
      onSendError: () => {},
      readSeededLaunchDraft: () => null,
      sleep: async () => {},
      scopeKey: scope,
      activeHandleRef: { current: null },
      structuredNativeChat: true,
      files: files.files,
      onFilesSent: files.removeFiles,
      baseSend: bridge.sendWithOutcome
    })
    full = {
      drafts: { ...drafts, composerText: useMobileNativeChatDraft(drafts.draftKey) },
      files,
      images,
      addImage: updateImages,
      addFile: updateFiles
    }
    return null
  }
  const image = { id: 'submitted-image', path: '/image.png', previewUri: 'file:///preview.png' }
  const file = {
    id: 'submitted-file',
    name: 'notes.txt',
    mime: 'text/plain',
    byteLength: 4,
    path: '/notes.txt'
  }
  await act(async () => {
    renderer = create(createElement(Full, { tab: 'tab-a' }))
  })
  act(() => {
    full.drafts.setComposerText('complete prompt')
    full.addImage(SCOPE_A, () => [image])
    full.addFile(SCOPE_A, () => [file])
  })
  let sent!: Promise<boolean>
  act(() => {
    sent = full.images.sendNativeChat(full.drafts.composerText)
  })
  await act(async () => {
    renderer?.unmount()
    renderer = create(createElement(Full, { tab: 'tab-b' }))
  })
  act(() => full.drafts.setComposerText('other chat'))
  await act(async () => {
    answer.resolve('rejected')
    await sent
  })
  expect(full.drafts.composerText).toBe('other chat')
  expect(full.images.attachments).toEqual([])
  await act(async () => renderer?.update(createElement(Full, { tab: 'tab-a' })))
  expect(full.drafts.composerText).toBe('complete prompt')
  expect(full.images.attachments).toEqual([image])
  expect(full.files.files).toEqual([file])
  answer = Promise.withResolvers<MobileNativeChatSendOutcome>()
  act(() => {
    sent = full.images.sendNativeChat(full.drafts.composerText)
  })
  expect(sendStructured.mock.calls.at(-1)).toEqual([
    'complete prompt',
    ['file:///preview.png'],
    expect.any(Number),
    [image, { kind: 'file', id: file.id, path: file.path }],
    []
  ])
  act(() => {
    full.drafts.setComposerText('newer typing')
    full.addImage(SCOPE_A, (current) => [...current, { ...image, id: 'newer-image' }])
    full.addFile(SCOPE_A, (current) => [...current, { ...file, id: 'newer-file' }])
  })
  await act(async () => renderer?.update(createElement(Full, { tab: 'tab-b' })))
  await act(async () => {
    answer.resolve('accepted')
    await sent
  })
  expect(full.drafts.composerText).toBe('other chat')
  await act(async () => renderer?.update(createElement(Full, { tab: 'tab-a' })))
  expect(full.drafts.composerText).toBe('newer typing')
  expect(full.images.attachments.map((image) => image.id)).toEqual(['newer-image'])
  expect(full.files.files.map((file) => file.id)).toEqual(['newer-file'])
})

it.each([100, 1000])(
  'isolates real text/image/file leaves across %i scopes while counting text and scoped input wake work',
  async (population) => {
    const scopes = Array.from({ length: population }, (_, index) =>
      index === 2 ? 'other-host\0w\0tab-0' : `h\0w\0tab-${index}`
    )
    const expected = scopes.map((_, index) => ({
      text: `Complete prompt for chat ${index}: preserve the original and newer attachment.`,
      images: ['original', 'newer'].map((age) => ({
        id: `${age}-image-${index}`,
        path: `/host/images/${age}-${index}.png`,
        previewUri: `file:///phone/previews/${age}-${index}.png`
      })),
      files: ['original', 'newer'].map((age) => ({
        id: `${age}-file-${index}`,
        name: `${age}-${index}.txt`,
        mime: 'text/plain',
        byteLength: 128 + index,
        path: `/host/files/${age}-${index}.txt`
      }))
    }))
    type Snapshot = {
      text: string
      images: Hook['attachments']
      files: ReturnType<typeof useMobileNativeChatFileAttachments>['files']
    }
    const shown: Snapshot[] = scopes.map(() => ({ text: '', images: [], files: [] }))
    const renders = scopes.map(() => ({ text: 0, images: 0, files: 0 }))
    const removeImages: Hook['removeAttachment'][] = []
    const removeFiles: ReturnType<typeof useMobileNativeChatFileAttachments>['removeFiles'][] = []
    act(() => {
      for (const [index, scope] of scopes.entries()) {
        setMobileNativeChatDraftText(scope, expected[index].text)
        updateImages(scope, () => expected[index].images)
        updateFiles(scope, () => expected[index].files)
      }
      renderer?.unmount()
    })
    expect(subscriptionWork.active).toBe(0)

    function Text({ index }: { index: number }): null {
      renders[index].text += 1
      shown[index].text = useMobileNativeChatDraft(scopes[index])
      return null
    }
    function Images({ index }: { index: number }): null {
      renders[index].images += 1
      const images = useMobileNativeChatImageAttachments({
        client: null,
        agent: 'codex',
        enabled: true,
        deviceTokenRef: { current: null },
        activeHandleRef: { current: null },
        getActiveWorktreeConnectionId: async () => null,
        connState: 'connected',
        showToast: () => {},
        onSendError: () => {},
        readSeededLaunchDraft: () => null,
        scopeKey: scopes[index],
        structuredNativeChat: true,
        baseSend: async () => {
          throw new Error('Subscription evidence must not dispatch')
        }
      })
      shown[index].images = images.attachments
      removeImages[index] = images.removeAttachment
      return null
    }
    function Files({ index }: { index: number }): null {
      renders[index].files += 1
      const files = useMobileNativeChatFileAttachments({
        client: null,
        sessionId: `session-${index}`,
        scopeKey: scopes[index],
        enabled: true,
        showToast: () => {}
      })
      shown[index].files = files.files
      removeFiles[index] = files.removeFiles
      return null
    }
    await act(async () => {
      renderer = create(
        createElement(
          Fragment,
          null,
          scopes.flatMap((scope, index) => [
            createElement(Text, { key: `text-${scope}`, index }),
            createElement(Images, { key: `images-${scope}`, index }),
            createElement(Files, { key: `files-${scope}`, index })
          ])
        )
      )
    })
    expect(shown).toEqual(expected)
    const listeners = population * 4
    expect(subscriptionWork.active).toBe(listeners)
    const measurements: object[] = []
    for (const target of [0, 1, 2]) {
      for (const kind of ['text', 'images', 'files'] as const) {
        const before = shown.map((snapshot) => ({ ...snapshot }))
        for (const count of renders) {
          count.text = count.images = count.files = 0
        }
        subscriptionWork.wakes = subscriptionWork.snapshots = 0
        await act(async () => {
          if (kind === 'text') {
            expected[target].text += '\nA newer scoped edit.'
            setMobileNativeChatDraftText(scopes[target], expected[target].text)
          } else if (kind === 'images') {
            removeImages[target](expected[target].images[0].id)
            expected[target].images = expected[target].images.slice(1)
          } else {
            removeFiles[target]([expected[target].files[0].id])
            expected[target].files = expected[target].files.slice(1)
          }
        })
        expect(shown).toEqual(expected)
        for (const [index, count] of renders.entries()) {
          for (const leaf of ['text', 'images', 'files'] as const) {
            if (index === target && leaf === kind) {
              expect(count[leaf]).toBeGreaterThan(0)
              expect(shown[index][leaf]).not.toBe(before[index][leaf])
            } else {
              expect(count[leaf]).toBe(0)
              expect(shown[index][leaf]).toBe(before[index][leaf])
            }
          }
        }
        const wakes = kind === 'text' ? population : 3
        expect(subscriptionWork.wakes).toBe(wakes)
        expect(subscriptionWork.snapshots).toBeGreaterThanOrEqual(wakes)
        expect(subscriptionWork.snapshots).toBeLessThanOrEqual((kind === 'text' ? 2 : 3) * wakes)
        measurements.push({
          target,
          kind,
          wakes: subscriptionWork.wakes,
          snapshots: subscriptionWork.snapshots,
          affectedRenders: renders[target][kind]
        })
      }
    }
    console.info('draft subscriber work', JSON.stringify({ population, listeners, measurements }))
    act(() => renderer?.unmount())
    renderer = null
    expect(subscriptionWork.active).toBe(0)
  }
)
