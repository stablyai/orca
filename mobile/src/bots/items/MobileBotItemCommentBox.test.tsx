import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'

vi.mock('react-native', async () => {
  const React = await import('react')
  const { reactNativeMotionStub } = await import('../../test-support/react-native-motion-stub')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement(name, props, children)
  return {
    ...reactNativeMotionStub(),
    Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
    Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove() {} }) },
    useColorScheme: () => 'dark',
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1,
      flatten: (s: unknown) => s
    }
  }
})
const { stub, field } = await vi.hoisted(async () => {
  const React = await import('react')
  return {
    stub:
      (name: string) =>
      ({ children, ...props }: { children?: ReactNode }) =>
        React.createElement(name, props, children),
    field: React.forwardRef((props: Record<string, unknown>, _ref) =>
      React.createElement('Field', props)
    )
  }
})
vi.mock('../../session/native-chat/composer/field/MobileNativeChatComposerField', () => ({
  MobileNativeChatComposerField: field
}))
vi.mock('../../session/native-chat/composer/menus/MobileNativeChatComposerMenu', () => ({
  MobileNativeChatComposerSuggestions: stub('Suggestions')
}))
vi.mock(
  '../../session/native-chat/composer/attachments/MobileNativeChatComposerAttachments',
  () => ({
    MobileNativeChatComposerAttachments: stub('Attachments')
  })
)
vi.mock(
  '../../session/native-chat/composer/attachments/MobileNativeChatComposerAttachButton',
  () => ({
    MobileNativeChatComposerAttachButton: stub('Attach')
  })
)
vi.mock('../../session/native-chat/composer/dictation/MobileNativeChatComposerMic', () => ({
  MobileNativeChatComposerMic: stub('Mic')
}))
vi.mock('../../session/native-chat/composer/dictation/MobileNativeChatDictationLeading', () => ({
  MobileNativeChatDictationLeading: stub('Leading')
}))
vi.mock(
  '../../session/native-chat/composer/dictation/use-mobile-native-chat-composer-dictation',
  () => ({ useMobileNativeChatComposerDictation: () => ({ preview: null, readSelection() {} }) })
)
vi.mock('../../components/composer-input/ComposerSendButton', () => ({
  ComposerSendButton: stub('Send')
}))
vi.mock('../../worktree/execution-hosts/use-route-capability', () => ({
  useRouteCapability: () => true
}))
vi.mock('./use-bot-item-comment-images', () => ({
  useBotItemCommentImages: () => ({
    images: [],
    uploading: false,
    attach() {},
    remove() {},
    clear() {}
  })
}))
vi.mock(
  '../../session/native-chat/composer/attachments/use-mobile-native-chat-workspace-catalog',
  () => ({
    useMobileNativeChatWorkspaceCatalog: () => ({
      nativeChatFilePaths: ['src/review.ts'],
      loadNativeChatFiles() {},
      nativeChatSkills: {
        status: 'ready',
        skills: [
          {
            id: 'release-notes',
            name: 'release-notes',
            description: 'Write the release notes',
            providers: ['claude'],
            sourceKind: 'repo',
            sourceLabel: 'Repository',
            rootPath: '/bots/b/.claude/skills',
            directoryPath: '/bots/b/.claude/skills/release-notes',
            skillFilePath: '/bots/b/.claude/skills/release-notes/SKILL.md',
            installed: true,
            updatedAt: null
          }
        ]
      },
      loadNativeChatSkills() {}
    })
  })
)

import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { makeTestBotItem } from '../../../../src/shared/bots/bot-item.test-fixture'
import { MobileBotItemCommentBox } from './MobileBotItemCommentBox'

it("offers the chat composer's files at @ and skills at /, and sends a picked skill with its file", async () => {
  const onComment = vi.fn()
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(
      createElement(MobileBotItemCommentBox, {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every read the box makes is mocked.
        client: {} as RpcClient,
        hostId: 'local',
        bot: { folderWorkspaceId: 'fw-1', agent: 'claude' },
        item: makeTestBotItem(9),
        online: true,
        hostName: 'Studio Mac',
        attachTo: null,
        onComment,
        showToast: () => {}
      })
    )
  })
  const field = () => tree.root.find((node) => String(node.type) === 'Field')
  const rows = () => tree.root.find((node) => String(node.type) === 'Suggestions').props.rows
  const type = async (text: string) => {
    await act(async () => field().props.onChangeText(text))
    await act(async () =>
      field().props.onSelectionChange({
        nativeEvent: { selection: { start: text.length, end: text.length } }
      })
    )
  }

  await type('See @rev')
  expect(rows().map((row: { id: string }) => row.id)).toEqual(['file:src/review.ts'])
  await act(async () => field().props.onKeyboardSubmit())
  expect(field().props.value).toBe('See @src/review.ts ')

  await type('/rel')
  expect(rows().map((row: { token: string }) => row.token)).toEqual(['/release-notes'])
  await act(async () => field().props.onKeyboardSubmit())
  expect(field().props.value).toBe('/release-notes ')
  expect(onComment).not.toHaveBeenCalled()

  await act(async () => field().props.onKeyboardSubmit())
  expect(onComment).toHaveBeenCalledWith(
    '/release-notes',
    [],
    [{ name: 'release-notes', path: '/bots/b/.claude/skills/release-notes/SKILL.md' }]
  )
})
