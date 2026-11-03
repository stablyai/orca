import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatTextBlock } from '../../../../../src/shared/native-chat/native-chat-types'
import { agentSessionFailureSentence } from '../../../../../src/shared/agent-session/failures/agent-session-failure-words'
import { AGENT_SESSION_ORCA_STOP_PRESENTATION } from '../../../../../src/shared/agent-session/lifecycle/agent-session-orca-stop'
import { MobileNativeChatNoticeRow } from './MobileNativeChatNoticeRow'
import { activateMobileUiLocale } from '../../../i18n/mobile-i18n'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({
  AlertCircle: 'AlertCircle',
  AlertTriangle: 'AlertTriangle',
  ChevronRight: 'ChevronRight',
  Info: 'Info'
}))
vi.mock('../../../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))

let tree: ReactTestRenderer
const diagnostic = 'Provider diagnostic: {{agent}} $&\nSession lookup failed.'
const frame = {
  provider: 'codex',
  kind: 'notification:error',
  payload: {
    head: '{"error":"raw provider frame"}',
    byteLength: 3000,
    digest: 'fixture',
    truncated: true
  }
}
function render(block: NativeChatTextBlock) {
  act(() => {
    tree = create(<MobileNativeChatNoticeRow blocks={[block]} fontScale={1.5} />)
  })
}
function text() {
  return tree.root
    .findAllByType('Text')
    .map((node) => node.children.join(''))
    .join('\n')
}
function toggle() {
  act(() => tree.root.findByType('Pressable').props.onPress())
}
afterEach(async () => {
  act(() => tree?.unmount())
  await activateMobileUiLocale('en')
})

it.each([
  { kind: 'savedConversationMissing', detail: { audience: 'person', text: diagnostic } },
  { kind: 'providerStartFailed', detail: { audience: 'log', text: diagnostic } },
  { kind: 'providerRejected', detail: { audience: 'person', text: diagnostic } }
] as const)(
  'discloses the literal %s diagnostic without replacing its plain sentence',
  (failure) => {
    const sentence = agentSessionFailureSentence(failure, 'row')
    render({ type: 'text', tone: 'error', text: sentence, failure })
    expect(text()).toContain(sentence)
    expect(text()).not.toContain(diagnostic)
    expect(tree.root.findByType('Pressable').props).toMatchObject({
      accessibilityRole: 'button',
      accessibilityLabel: 'Details',
      'aria-expanded': false
    })
    toggle()
    expect(text()).toContain(sentence)
    expect(text()).toContain(diagnostic)
    const body = tree.root.findAllByType('Text').find((node) => node.children.includes(diagnostic))!
    expect(body.props.selectable).toBe(true)
    expect(body.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ fontSize: 18 })])
    )
    toggle()
    expect(text()).not.toContain(diagnostic)
    expect(text()).toContain(sentence)
  }
)

it('keeps a provider frame and failure detail together behind the translated control', async () => {
  await activateMobileUiLocale('zh')
  render({
    type: 'text',
    tone: 'warning',
    text: 'Codex could not finish.',
    failure: { kind: 'providerRejected', detail: { audience: 'person', text: diagnostic } },
    providerFrame: frame
  })
  expect(tree.root.findByType('Pressable').props.accessibilityLabel).toBe('详情')
  expect(text()).not.toContain(frame.payload.head)
  toggle()
  expect(text()).toContain('Codex could not finish.')
  expect(text()).toContain(diagnostic)
  expect(text()).toContain(frame.payload.head)
  expect(text()).toContain('3000')
})

it('makes a frame-only ordinary notice reachable and avoids repeating an identical detail', () => {
  render({
    type: 'text',
    tone: 'error',
    text: 'Codex could not finish.',
    providerFrame: frame,
    failure: {
      kind: 'providerRejected',
      detail: { audience: 'person', text: 'Codex could not finish.' }
    }
  })
  toggle()
  expect(text().split('Codex could not finish.')).toHaveLength(2)
  expect(text()).toContain(frame.payload.head)
})

it('retains settled permission disclosure and the plain stop notice', () => {
  render({
    type: 'text',
    tone: 'warning',
    text: 'Safety review explanation.',
    providerFrame: { ...frame, kind: 'notification:guardianWarning' }
  })
  expect(text()).toContain('Codex reported a safety review warning. View details.')
  expect(text()).not.toContain('Safety review explanation.')
  toggle()
  expect(text()).toContain('Safety review explanation.')
  expect(text()).toContain(frame.payload.head)
  act(() => tree.unmount())
  render({
    type: 'text',
    tone: 'error',
    text: 'Old host stop text',
    presentation: AGENT_SESSION_ORCA_STOP_PRESENTATION,
    orcaStop: { cause: 'crash' }
  })
  expect(tree.root.findAllByType('Pressable')).toHaveLength(0)
  expect(text()).not.toContain('Old host stop text')
})
