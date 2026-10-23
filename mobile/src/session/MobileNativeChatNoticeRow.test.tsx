import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatTextBlock } from '../../../src/shared/native-chat-types'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  Platform: { OS: 'ios' },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({
  AlertCircle: 'AlertCircle',
  AlertTriangle: 'AlertTriangle',
  Info: 'Info',
  ChevronRight: 'ChevronRight',
  RotateCcw: 'RotateCcw'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))

import { MobileNativeChatNoticeRow } from './MobileNativeChatNoticeRow'
import { colors } from '../theme/mobile-theme'
import { RotateCcw } from 'lucide-react-native'

let renderer: ReactTestRenderer | undefined
afterEach(() => act(() => renderer?.unmount()))

it('opens only the selected repeated notice and retains the complete mobile message', () => {
  const block: NativeChatTextBlock = {
    type: 'text',
    tone: 'warning',
    text: 'Ignored setting.\n\nfeatures.example is ignored in /config.toml.',
    providerFrame: {
      provider: 'codex',
      kind: 'notification:configWarning',
      payload: { head: '{}', byteLength: 2, digest: 'digest', truncated: false }
    }
  }
  act(() => {
    renderer = create(
      <>
        <MobileNativeChatNoticeRow blocks={[block]} fontScale={1} messageId="first" />
        <MobileNativeChatNoticeRow blocks={[block]} fontScale={1} messageId="second" />
      </>
    )
  })
  const buttons = renderer!.root.findAllByProps({ accessibilityRole: 'button' })
  expect(buttons).toHaveLength(2)
  expect(buttons.map((button) => button.props.accessibilityState.expanded)).toEqual([false, false])
  expect(JSON.stringify(renderer!.toJSON())).not.toContain('features.example')
  act(() => buttons[0]!.props.onPress())
  expect(buttons.map((button) => button.props.accessibilityState.expanded)).toEqual([true, false])
  expect(renderer!.root.findAllByProps({ children: block.text })).toHaveLength(1)
  act(() => buttons[0]!.props.onPress())
  expect(JSON.stringify(renderer!.toJSON())).not.toContain('features.example')
})

it('keeps retry progress neutral and reveals its original cause', () => {
  const block: NativeChatTextBlock = {
    type: 'text',
    tone: 'warning',
    text: 'Claude is retrying.\nLast error: HTTP 503.',
    failure: { kind: 'providerRetrying', retry: { attempt: 2, maxRetries: 5 } }
  }
  act(() => {
    renderer = create(<MobileNativeChatNoticeRow blocks={[block]} fontScale={1} />)
  })
  expect(renderer!.root.findByType(RotateCcw).props.color).toBe(colors.textMuted)
  expect(renderer!.root.findAllByProps({ children: 'Retrying · 2 of 5' })).toHaveLength(1)
  expect(renderer!.root.findAllByProps({ children: block.text })).toHaveLength(0)
  act(() => renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress())
  expect(renderer!.root.findAllByProps({ children: block.text })).toHaveLength(1)
})
