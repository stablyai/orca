import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ ChevronRight: 'ChevronRight', Goal: 'Goal' }))
vi.mock('../../../../bots/MobileConnectorSourceIcon', () => ({
  MobileConnectorSourceIcon: 'MobileConnectorSourceIcon'
}))
vi.mock('../../slack-mirror/MobileSlackMirrorPost', () => ({ MobileSlackMirrorPostLine: 'Line' }))
vi.mock('../MobileNativeChatBotRowNotes', () => ({ MobileNativeChatAutomationResultsCarried: 'N' }))

import {
  MobileNativeChatConnectorAskerTag,
  MobileQueuedTypedByLine
} from './MobileNativeChatUserMessageMarks'

function render(element: ReturnType<typeof createElement>): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(element)
  })
  return renderer!
}

// The mocked Text renders a host element named `Text`, outside React's intrinsic element names.
const isHostText = (type: unknown): boolean => type === 'Text'

const texts = (renderer: ReactTestRenderer) =>
  renderer.root.findAll((node) => isHostText(node.type)).map((node) => node.props.children)

describe('phone marks for a message another person typed', () => {
  it('reads "From" before the name on a queued card, as on desktop', () => {
    const line = render(
      createElement(MobileQueuedTypedByLine, {
        typist: { name: 'Sam Lee', computer: "Sam's MacBook Pro" },
        textStyle: {}
      })
    )
    expect(texts(line)).toEqual(['From', 'Sam Lee', '·', "Sam's MacBook Pro"])
  })

  it('never speaks "You" on the nameless Slack tag beside their name', () => {
    const tag = render(
      createElement(MobileNativeChatConnectorAskerTag, {
        asker: {
          source: 'slack',
          userId: 'owner',
          role: 'owner',
          place: { kind: 'channel', id: 'C9' },
          url: 'https://app.slack.com/client/T1/C9'
        },
        nameless: true
      })
    )
    const label = String(
      tag.root.findByProps({ accessibilityRole: 'link' }).props.accessibilityLabel
    )
    expect(label).not.toContain('You')
    expect(texts(tag)).not.toContain('You')
  })
})
