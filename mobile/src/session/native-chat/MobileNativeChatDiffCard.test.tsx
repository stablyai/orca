import './transcript/mobile-agent-message-renderer.test-fixture'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import { findAllByHostType } from '../../test-support/react-test-renderer-host-nodes'
import { Transcript, textIn } from './transcript/mobile-native-chat-turn-diff.test-fixture'

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

it('shows finished-turn files outside folded work and opens a patch with one tap', () => {
  act(() => {
    renderer = create(createElement(Transcript, { working: true }))
  })
  expect(textIn(renderer!.root)).toContain('greeting.ts')
  act(() => {
    renderer!.update(createElement(Transcript))
  })
  expect(textIn(renderer!.root)).toContain('greeting.ts')
  expect(textIn(renderer!.root)).not.toContain('diagnostic-output')
  expect(textIn(renderer!.root)).not.toContain('helloNew()')
  const file = findAllByHostType(renderer!.root, 'Pressable').find(
    (node) => node.props.accessibilityLabel === '/repo/greeting.ts'
  )!
  act(() => file.props.onPress())
  expect(textIn(renderer!.root)).toContain('helloNew()')
  expect(textIn(renderer!.root)).not.toContain('statusNew()')
  act(() => renderer!.unmount())
  act(() => {
    renderer = create(createElement(Transcript))
  })
  expect(textIn(renderer!.root)).toContain('status.ts')
})
