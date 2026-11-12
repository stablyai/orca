import {
  addMobileNativeChatDraftImages,
  closeMobileNativeChatEditInputs,
  mobileNativeChatDraftDestination
} from './mobile-native-chat-draft-inputs'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import '../../../../../src/shared/agent-launch/startup/agent-tui-input-clear'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubRpcClient } from '../../../transport/rpc/rpc-client-test-stub'
import { resetMobileNativeChatStaleInputForTests } from './mobile-native-chat-stale-input'
import { resetMobileNativeChatTerminalWritesForTests } from './mobile-native-chat-terminal-write-lock'
import { useMobileNativeChatImageAttachments } from './use-mobile-native-chat-image-attachments'

// Stub the media seam so direct Expo imports would expose unsupported Flow syntax and fail the transform.
const pick = vi.hoisted(() => vi.fn())
const ids = vi.hoisted(() => ({ next: 0 }))
vi.mock('../../../../../src/shared/non-secure-context-uuid', () => ({
  createNonSecureContextUuid: () => `img-${++ids.next}`
}))
const pastePaths = vi.hoisted(() => vi.fn())
vi.mock('./mobile-native-chat-image-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-native-chat-image-send')>()),
  pasteMobileNativeChatImagePaths: pastePaths
}))
vi.mock('../../../platform/media-picker', () => ({ useMediaPicker: () => ({ pickImages: pick }) }))
// The canvas fit needs a WebView.
vi.mock('../../../files/attachments/mobile-agent-image-fit', () => ({
  fitMobileAgentImage: async (image: unknown) => image
}))

type HookArgs = Parameters<typeof useMobileNativeChatImageAttachments>[0]
type Hook = ReturnType<typeof useMobileNativeChatImageAttachments>

const SCOPE_A = 'h\0w\0tab-a'

function baseArgs(overrides: Partial<HookArgs> & Pick<HookArgs, 'client'>): HookArgs {
  return {
    agent: 'claude',
    activeHandleRef: { current: 'term-1' },
    deviceTokenRef: { current: null },
    getActiveWorktreeConnectionId: async () => null,
    connState: 'connected',
    scopeKey: SCOPE_A,
    enabled: true,
    structuredNativeChat: false,
    showToast: vi.fn(),
    onSendError: vi.fn(),
    baseSend: vi.fn().mockResolvedValue('accepted'),
    readSeededLaunchDraft: () => null,
    sleep: async () => {},
    ...overrides
  }
}

describe('useMobileNativeChatImageAttachments', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: Hook | null = null

  function Harness({ args }: { args: HookArgs }): null {
    hook = useMobileNativeChatImageAttachments(args)
    return null
  }

  beforeEach(() => {
    ids.next = 0
    pick.mockReset()
    pastePaths.mockReset()
    resetMobileNativeChatStaleInputForTests()
    resetMobileNativeChatTerminalWritesForTests()
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    closeMobileNativeChatEditInputs(SCOPE_A)
    renderer = null
    hook = null
  })

  function mount(args: HookArgs): void {
    act(() => {
      renderer = create(createElement(Harness, { args }))
    })
  }

  describe('terminal chat files', () => {
    const file = (id: string, path: string | null) => ({
      id,
      name: path?.split('/').at(-1) ?? 'pending.bin',
      mime: 'video/mp4',
      byteLength: 10,
      sentBytes: 0,
      path
    })
    const client = stubRpcClient()

    it('terminal send appends @references for stored files', async () => {
      const baseSend = vi.fn().mockResolvedValue('accepted')
      const onFilesSent = vi.fn()
      mount(
        baseArgs({
          client,
          baseSend,
          onFilesSent,
          files: [file('f1', '/tmp/orca-paste-1/lenta 1.mp4')]
        })
      )
      let sent = false
      await act(async () => {
        sent = await hook!.sendNativeChat('Разбери видео')
      })
      expect(sent).toBe(true)
      expect(baseSend.mock.calls[0]![0]).toBe('Разбери видео')
      expect(baseSend.mock.calls[0]![5]).toMatchObject({
        wireText: 'Разбери видео\n@"/tmp/orca-paste-1/lenta 1.mp4" '
      })
      expect(onFilesSent.mock.calls[0]![0]).toEqual(['f1'])
    })

    it('terminal send with a photo and a file pastes the photo path first', async () => {
      const order: string[] = []
      pastePaths.mockImplementation(async () => {
        order.push('paste')
        return true
      })
      const baseSend = vi.fn().mockImplementation(async () => {
        order.push('send')
        return 'accepted'
      })
      mount(
        baseArgs({
          client,
          baseSend,
          files: [file('f2', '/tmp/orca-paste-2/doc.pdf')]
        })
      )
      act(() => {
        addMobileNativeChatDraftImages(mobileNativeChatDraftDestination(SCOPE_A), [
          { path: '/tmp/photo.png', previewUri: 'file:///photo.png' }
        ])
      })
      await act(async () => {
        await hook!.sendNativeChat('look')
      })
      expect(pastePaths.mock.calls[0]![0].imagePaths).toEqual(['/tmp/photo.png'])
      expect(baseSend.mock.calls[0]![5].wireText).toContain('@/tmp/orca-paste-2/doc.pdf')
      expect(order).toEqual(['paste', 'send'])
    })

    it('terminal send waits while a file is uploading', async () => {
      const baseSend = vi.fn().mockResolvedValue('accepted')
      mount(baseArgs({ client, baseSend, files: [file('f3', null)] }))
      let sent = true
      await act(async () => {
        sent = await hook!.sendNativeChat('hold on')
      })
      expect(sent).toBe(false)
      expect(baseSend).not.toHaveBeenCalled()
    })
  })
})
