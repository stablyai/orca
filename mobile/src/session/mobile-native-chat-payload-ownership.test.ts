import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  resetMobileNativeChatDraftStoreForTests,
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
