import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { colors } from '../theme/mobile-theme'

const mocks = vi.hoisted(() => ({
  openURL: vi.fn(async () => {}),
  copy: vi.fn()
}))
vi.mock('react-native', () => ({
  Image: 'Image',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Linking: { openURL: mocks.openURL }
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.copy }))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  Copy: 'Copy',
  AlertCircle: 'AlertCircle',
  AlertTriangle: 'AlertTriangle',
  Info: 'Info'
}))
vi.mock('../components/pr-sidebar/MermaidDiagram', () => ({
  MermaidDiagram: 'MermaidDiagram'
}))
vi.mock('./MobileNativeChatToolRun', () => ({ ToolRun: 'ToolRun' }))
vi.mock('./MobileNativeChatTurnStatus', () => ({
  MobileNativeChatTurnStatus: 'MobileNativeChatTurnStatus'
}))

let renderer: ReactTestRenderer | null = null
const text = 'Please run `/login`. Read [enrollment](https://example.test/enroll).'
function render(role: NativeChatMessage['role'], tone?: 'notice' | 'warning' | 'error') {
  const onOpenFile = vi.fn()
  act(() => {
    renderer = create(
      createElement(MobileNativeChatMessage, {
        message: {
          id: 'record',
          role,
          timestamp: null,
          source: 'transcript',
          blocks: [{ type: 'text', text, ...(tone ? { tone } : {}) }]
        },
        fontScale: 1.2,
        onOpenFile
      })
    )
  })
  return { root: renderer!.root, onOpenFile }
}
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  vi.clearAllMocks()
})

describe('mobile system notice presentation', () => {
  it.each([
    ['notice', 'System notice', 'Info', colors.textMuted],
    ['warning', 'System warning', 'AlertTriangle', colors.statusAmber],
    ['error', 'System error', 'AlertCircle', colors.statusRed]
  ] as const)('keeps %s severity distinct from assistant content', (tone, label, icon, color) => {
    const { root } = render('system', tone)
    expect(root.findByType(icon).props.color).toBe(color)
    expect(root.findAllByType('Text').some((node) => node.props.children === label)).toBe(true)
    expect(root.findAllByProps({ accessibilityLabel: 'Copy message' })).toHaveLength(0)
    expect(
      root.findAllByProps({
        accessibilityLabel: 'Scroll this message to top'
      })
    ).toHaveLength(0)
  })

  it('uses markdown web links without turning slash commands into file actions', async () => {
    const { root, onOpenFile } = render('system', 'notice')
    const command = root.findAllByType('Text').find((node) => node.props.children === '/login')!
    expect(command).toBeDefined()
    expect(command.props.onPress).toBeUndefined()
    const link = root.findAllByType('Text').find((node) => node.props.children === 'enrollment')!
    await act(async () => link.props.onPress())
    expect(mocks.openURL).toHaveBeenCalledWith('https://example.test/enroll')
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('preserves user bubbles and assistant controls without notice impersonation', () => {
    const { root } = render('user')
    expect(root.findAllByType('Text').some((node) => node.props.children === text)).toBe(true)
    expect(root.findAllByType('Info')).toHaveLength(0)
    act(() => renderer?.unmount())
    const assistant = render('assistant', 'notice').root
    expect(assistant.findAllByProps({ accessibilityLabel: 'Copy message' })).toHaveLength(1)
    expect(assistant.findAllByType('Info')).toHaveLength(0)
  })
})
