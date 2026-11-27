import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatBlock } from '../../../../../../src/shared/native-chat/native-chat-types'
import {
  MobileNativeChatBotIdentityContext,
  type MobileNativeChatBotIdentity
} from '../../mobile-native-chat-bot-identity'
import { MobileNativeChatAnswerProse } from './MobileNativeChatAnswerProse'

vi.mock('react-native', () => ({
  Text: 'Text',
  StyleSheet: { create: (x: unknown) => x }
}))
vi.mock('../../../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../messages/mobile-native-chat-message-styles', () => ({
  stylesSheet: { resolve: () => ({}) },
  scaledType: () => ({})
}))
vi.mock('./MobileNativeChatPacedProse', () => ({
  MobileNativeChatPacedProse: ({ blocks }: { blocks: NativeChatBlock[] }) =>
    createElement(
      'Text',
      null,
      blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    )
}))

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

/** A group room's member turn: its identity names the bot but carries no botId. */
const groupMember: MobileNativeChatBotIdentity = {
  name: 'Triage',
  avatar: { kind: 'text', text: 'T' }
}

function shownText(text: string, bot: MobileNativeChatBotIdentity | null): string {
  act(() => renderer?.unmount())
  act(() => {
    renderer = create(
      <MobileNativeChatBotIdentityContext.Provider value={bot}>
        <MobileNativeChatAnswerProse
          rowKey="answer"
          blocks={[{ type: 'text', text }]}
          growingBlock={undefined}
          paced
          fontScale={1}
        >
          {() => null}
        </MobileNativeChatAnswerProse>
      </MobileNativeChatBotIdentityContext.Provider>
    )
  })
  return renderer!.root
    .findAll(() => true)
    .flatMap((node) => node.children.filter((child) => typeof child === 'string'))
    .join('\n')
}

it("draws a group member's quiet result as its bot chat does, never its marker", () => {
  const note = shownText('Moved ITEM-1 to done.\n\nNO_REPLY', groupMember)
  expect(note).toContain('Moved ITEM-1 to done.')
  expect(note).not.toContain('NO_REPLY')
  expect(shownText('NO_REPLY', groupMember)).toBe('Nothing to report')
  expect(shownText('Done, see ITEM-1.', groupMember)).toBe('Done, see ITEM-1.')
  // Outside a bot's chat or a group room, an agent's words draw as written.
  expect(shownText('NO_REPLY', null)).toBe('NO_REPLY')
})
