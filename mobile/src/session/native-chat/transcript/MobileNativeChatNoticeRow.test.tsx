import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatTextBlock } from '../../../../../src/shared/native-chat/native-chat-types'
import { agentSessionFailureSentence } from '../../../../../src/shared/agent-session/failures/agent-session-failure-words'
import { MobileNativeChatNoticeRow } from './MobileNativeChatNoticeRow'
import { activateMobileUiLocale } from '../../../i18n/mobile-i18n'
import { agentSessionFailureFact } from '../../../../../src/shared/agent-session/failures/agent-session-failure'

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
function render(block: NativeChatTextBlock) {
  act(() => {
    tree = create(<MobileNativeChatNoticeRow blocks={[block]} fontScale={1.5} />)
  })
}
function text() {
  return tree.root
    .findAll((node) => String(node.type) === 'Text')
    .map((node) => node.children.join(''))
    .join('\n')
}
afterEach(async () => {
  act(() => tree?.unmount())
  await activateMobileUiLocale('en')
})

it('translates canonical plugin failures without repeating their identity or rewriting host advice', async () => {
  const failure = agentSessionFailureFact('pluginInputRequired', {
    detail: { audience: 'person', text: 'blast-radius' }
  })
  const sentence = agentSessionFailureSentence(failure, 'row')
  render({ type: 'text', tone: 'error', text: sentence, failure })
  expect(text()).toContain(sentence)
  expect(tree.root.findAll((node) => String(node.type) === 'Pressable')).toHaveLength(0)
  act(() => tree.unmount())
  await activateMobileUiLocale('fr')
  render({ type: 'text', tone: 'error', text: sentence, failure })
  expect(text()).toContain('le plugin « blast-radius » attend une saisie')
  expect(text()).not.toContain('waiting for input')
  expect(tree.root.findAll((node) => String(node.type) === 'Pressable')).toHaveLength(0)
  act(() => tree.unmount())
  render({ type: 'text', tone: 'error', text: 'Custom host recovery advice.', failure })
  expect(text()).toContain('Custom host recovery advice.')
})
