import { createElement } from 'react'
import { findByHostType } from '../test-support/react-test-renderer-host-nodes'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { MobileQueuedMessageComposer } from './MobileQueuedMessageComposer'
import { MobileQueuedMessageComposerContext } from './mobile-queued-message-composer-context'
import {
  readMobileNativeChatDraftInputs,
  resetMobileNativeChatDraftInputsForTests
} from './native-chat/composer/mobile-native-chat-draft-inputs'

vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }))
vi.mock('./native-chat/composer/MobileNativeChatComposer', () => ({
  MobileNativeChatComposer: 'Composer'
}))
vi.mock('./native-chat/composer/use-mobile-native-chat-file-attachments', () => ({
  useMobileNativeChatFileAttachments: () => ({
    files: [],
    attachFiles: vi.fn(),
    removeFiles: vi.fn()
  })
}))
vi.mock('./native-chat/composer/use-mobile-native-chat-image-upload', () => ({
  useMobileNativeChatImageUpload: () => ({ attachImage: vi.fn(async () => {}), isAttaching: false })
}))

describe('queued phone composer action boundary', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(() => {
    act(() => renderer?.unmount())
    resetMobileNativeChatDraftInputsForTests()
  })

  it('saves literal text while refusing picked executable controls and retaining skill picks', async () => {
    const save = vi.fn(async () => true)
    const onError = vi.fn()
    const client = new FakeSession('connected')
    await act(async () => {
      renderer = create(
        createElement(
          MobileQueuedMessageComposerContext.Provider,
          {
            value: {
              agent: 'codex',
              structured: null,
              filePaths: [],
              onNeedFiles: undefined,
              onError,
              onMicPress: undefined,
              micActive: false,
              dictationMode: undefined,
              onMicPressIn: vi.fn(),
              onMicPressOut: vi.fn()
            }
          },
          createElement(MobileQueuedMessageComposer, {
            attribution: null,
            editor: {
              messageId: 'card',
              scopeKey: 'edit',
              sessionId: 'session',
              client,
              imagesCapable: true,
              text: 'hello',
              saving: false,
              canSave: true,
              change: vi.fn(),
              save,
              removeImage: vi.fn(),
              cancel: vi.fn()
            }
          })
        )
      )
    })
    const composer = findByHostType(renderer!.root, 'Composer')
    await act(async () => {
      expect(await composer.props.onSend('/compact')).toBe(true)
      expect(await composer.props.onSend('/goal research')).toBe(true)
      expect(composer.props.editSession.refuseCommand('/resume')).toBe(true)
    })
    expect(save).toHaveBeenCalledTimes(2)
    save.mockClear()
    expect(client.sendRequest).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    act(() => composer.props.onPickSkill({ name: 'review', path: '/remote/SKILL.md' }))
    expect(readMobileNativeChatDraftInputs('edit').skills).toEqual([
      { name: 'review', path: '/remote/SKILL.md' }
    ])
    await act(async () => expect(await composer.props.onSend('hello')).toBe(true))
    expect(save).toHaveBeenCalledOnce()
    expect(client.sendRequest).not.toHaveBeenCalled()
  })
})
