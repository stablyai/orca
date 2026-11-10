import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileHomeEmptyState } from './MobileHomeEmptyState'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-reanimated', () => ({ default: { View: 'AnimatedView' } }))
vi.mock('lucide-react-native', () => ({ QrCode: 'QrCode' }))
vi.mock('../components/OrcaLogo', () => ({ OrcaLogo: 'OrcaLogo' }))

describe('MobileHomeEmptyState', () => {
  const mounted: ReturnType<typeof create>[] = []
  afterEach(() => {
    act(() => mounted.splice(0).forEach((renderer) => renderer.unmount()))
  })

  // The no-desktop Home: the phone reaches Orca Cloud through a paired desktop (#42), so the empty
  // state has to say where cloud workspaces will show up (W9 finding; copy signed off by design squad).
  it('says Orca Cloud workspaces show up once a desktop is paired', () => {
    const onPairDesktop = vi.fn()
    act(() => {
      mounted.push(
        create(
          createElement(MobileHomeEmptyState, {
            contentMaxWidth: 600,
            isWideLayout: false,
            bottomInset: 0,
            onPairDesktop
          })
        )
      )
    })
    expect(mounted).toHaveLength(1)
    for (const { root } of mounted) {
      const texts = root
        .findAll((node) => String(node.type) === 'Text')
        .map((node) => node.children.join(''))
      expect(texts).toContain('Connect your desktop')
      expect(texts).toContain('Your Orca Cloud workspaces show up here once a desktop is paired.')
      expect(texts).toContain(
        'Your desktop and your Orca Cloud workspaces will appear here. Everything is encrypted end-to-end.'
      )
      const pair = root.find((node) => String(node.type) === 'Pressable')
      act(() => pair.props.onPress())
    }
    expect(onPairDesktop).toHaveBeenCalledTimes(1)
  })
})
