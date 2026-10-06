import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat-session-options'
import { DescriptorRows } from './MobileNativeChatSessionOptionRows'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Switch: 'Switch',
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight'
}))

const FAST: SessionOptionDescriptor = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', currentValue: false },
  valueSource: 'reported',
  transport: 'catalog',
  settable: true
}

function renderRows(descriptor: SessionOptionDescriptor): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(
      createElement(DescriptorRows, {
        descriptor,
        disabled: false,
        onSetOption: vi.fn(),
        onInvokeAction: vi.fn()
      })
    )
  })
  if (!renderer) {
    throw new Error('renderer did not mount')
  }
  return renderer
}

const textOf = (renderer: ReactTestRenderer): string[] =>
  renderer.root.findAllByType('Text').flatMap((node) => {
    const children = node.props.children
    return typeof children === 'string' ? [children] : []
  })

describe('DescriptorRows boolean', () => {
  it('renders one switch and no unknown-value caption', () => {
    const renderer = renderRows({ ...FAST, valueSource: 'unknown' })
    expect(renderer.root.findAllByType('Switch')).toHaveLength(1)
    expect(textOf(renderer)).not.toContain('Current value unknown')
  })

  // Both arms: `default` and `unreported` make opposite claims, and only
  // `unreported` is reachable in the structured lane, so one arm proves nothing.
  it.each([
    {
      name: 'a live unreported boolean is never labelled a default',
      valueSource: 'unknown',
      transport: 'agent-session',
      shown: 'Not reported',
      hidden: 'Default'
    },
    {
      name: 'a draft catalog default says so',
      valueSource: 'default',
      transport: 'catalog',
      shown: 'Default',
      hidden: 'Not reported'
    }
  ] as const)('$name', ({ valueSource, transport, shown, hidden }) => {
    const renderer = renderRows({ ...FAST, valueSource, transport })
    expect(textOf(renderer)).toContain(shown)
    expect(textOf(renderer)).not.toContain(hidden)
    // The marker qualifies the value; it must not become part of the control's name.
    expect(renderer.root.findByType('Switch').props.accessibilityLabel).toBe('Fast mode')
  })

  it('drops the marker once something has picked the value', () => {
    const labels = textOf(renderRows(FAST))
    expect(labels).not.toContain('Default')
    expect(labels).not.toContain('Not reported')
  })

  it('shows the resolved value on the switch itself', () => {
    const renderer = renderRows({
      ...FAST,
      kind: { type: 'boolean', currentValue: true },
      valueSource: 'unknown'
    })
    expect(renderer.root.findByType('Switch').props.value).toBe(true)
  })
})
