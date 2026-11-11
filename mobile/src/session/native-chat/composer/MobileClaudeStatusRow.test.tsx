import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { ClaudeSessionStatus } from '../../../../../src/shared/native-chat/claude-session-status'
import { MobileClaudeStatusRow } from './MobileClaudeStatusRow'

vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove: () => {} }) },
  useColorScheme: () => 'dark'
}))

const rendered: ReactTestRenderer[] = []

afterEach(() => {
  act(() => rendered.splice(0).forEach((renderer) => renderer.unmount()))
})

function render(status: ClaudeSessionStatus | null): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(createElement(MobileClaudeStatusRow, { status }))
  })
  rendered.push(renderer!)
  return renderer!
}

const textOf = (renderer: ReactTestRenderer): string =>
  renderer.root
    .findAll((node) => (node.type as unknown) === 'Text' && node.parent?.type !== 'Text')
    .map((node) => node.children.join(''))
    .join(' | ')

const STATUS: ClaudeSessionStatus = {
  model: 'claude-opus-5-5',
  effort: 'high',
  usedTokens: 340000,
  windowTokens: 1000000,
  compactions: 4
}

it('shows percent, tokens and compactions', () => {
  expect(textOf(render(STATUS))).toBe('34% | 340k / 1M | · | compacted 4×')
})

it('shows tokens alone when the window is unknown', () => {
  expect(textOf(render({ ...STATUS, windowTokens: null }))).toBe('340k | · | compacted 4×')
})

it('says the context updates after the next reply right after a compaction', () => {
  expect(textOf(render({ ...STATUS, usedTokens: null }))).toBe(
    'context updates after next reply | · | compacted 4×'
  )
})

it('renders nothing without a status', () => {
  expect(render(null).toJSON()).toBeNull()
})
