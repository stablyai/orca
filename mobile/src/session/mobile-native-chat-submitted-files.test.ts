import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useMobileSessionImageAttachments } from './use-mobile-session-image-attachments'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import {
  hydrateMobileNativeChatDraft,
  resetMobileNativeChatDraftStoreForTests
} from './mobile-native-chat-draft-store'
import { publishMobileChatDraftStorage } from './mobile-native-chat-draft-storage'

const picker = vi.hoisted(() => ({ name: 'sent.txt' }))
vi.mock('../platform/media-picker', () => ({
  useMediaPicker: () => ({
    pickImages: async () => [],
    pickFiles: async function* () {
      yield { name: picker.name, mime: 'text/plain', byteLength: 1, base64: 'YQ==' }
    }
  })
}))
vi.mock('./mobile-agent-session-attachment-upload', () => ({
  uploadMobileAgentSessionAttachment: async (_client: unknown, file: { name: string }) => ({
    name: file.name,
    path: `/stored/${file.name}`,
    byteLength: 1
  })
}))
vi.mock('./use-mobile-image-attachment', () => ({
  useMobileImageAttachment: () => ({ attachImage: async () => {}, isAttaching: false })
}))

it('consumes only submitted completed files after storage handoff through the session wrapper', async () => {
  const scope = 'submitted-files\0workspace\0tab'
  const storage = () => ({
    read: async () => null,
    write: async () => {},
    removeWorkspace: async () => {}
  })
  publishMobileChatDraftStorage(storage())
  await hydrateMobileNativeChatDraft(scope)
  const client = createFakeRpcClient()
  let finish = (_outcome: 'unknown') => {}
  const baseSend = vi.fn(
    (
      ..._args: Parameters<
        Parameters<typeof useMobileSessionImageAttachments>[0]['nativeChatBaseSend']
      >
    ) =>
      new Promise<'unknown'>((resolve) => {
        finish = resolve
      })
  )
  let api: ReturnType<typeof useMobileSessionImageAttachments>
  function Harness() {
    api = useMobileSessionImageAttachments({
      client,
      agent: 'codex',
      activeHandle: null,
      activeHandleRef: { current: null },
      deviceTokenRef: { current: null },
      canSend: true,
      connState: 'connected',
      nativeChatScopeKey: scope,
      nativeChatInputLeaseReady: true,
      nativeChatAgentConfirmed: true,
      getActiveWorktreeConnectionId: async () => null,
      beforeTerminalSend: async () => true,
      nativeChatBaseSend: baseSend,
      structuredNativeChat: true,
      nativeChatSessionId: 'session',
      readSeededLaunchDraft: () => null,
      showToast: vi.fn(),
      onNativeChatSendError: vi.fn(),
      onSuccess: vi.fn(),
      onError: vi.fn()
    })
    return null
  }
  let renderer: ReturnType<typeof create> | undefined
  try {
    picker.name = 'sent.txt'
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await api.nativeChatFiles.attachFiles()
    })
    const sent = api!.nativeChatFiles.files[0]!
    const oldManualRemove = api!.nativeChatFiles.removeFiles
    let sending: Promise<boolean>
    await act(async () => {
      sending = api.nativeChatImages.sendNativeChat('look')
    })
    expect(baseSend.mock.calls[0]?.[3]).toEqual([
      { kind: 'file', id: sent.id, path: '/stored/sent.txt' }
    ])
    await act(async () => {
      publishMobileChatDraftStorage(null)
      publishMobileChatDraftStorage(storage())
      publishMobileChatDraftStorage(storage())
      await hydrateMobileNativeChatDraft(scope)
      renderer!.update(createElement(Harness))
    })
    picker.name = 'later.txt'
    await act(async () => {
      await api.nativeChatFiles.attachFiles()
      oldManualRemove([sent.id])
    })
    expect(api!.nativeChatFiles.files.map((file) => file.name)).toEqual(['sent.txt', 'later.txt'])
    await act(async () => {
      finish('unknown')
      expect(await sending).toBe(true)
    })
    expect(api!.nativeChatFiles.files.map((file) => file.name)).toEqual(['later.txt'])
  } finally {
    await act(async () => renderer?.unmount())
    resetMobileNativeChatDraftStoreForTests()
    publishMobileChatDraftStorage(null)
  }
})
