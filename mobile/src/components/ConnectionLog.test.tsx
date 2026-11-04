import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionLogEntry } from '../transport/types'
import { ConnectionLog } from './ConnectionLog'

vi.mock('react-native', () => ({
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

const duplicateEntries: ConnectionLogEntry[] = [
  { id: 'relay-1', ts: 1, level: 'info', message: 'Relay recovery started' },
  { id: 'relay-1', ts: 2, level: 'warn', message: 'Relay retry scheduled' }
]

describe('ConnectionLog', () => {
  type RenderedNode = { props: { style?: unknown } }
  type Renderer = {
    root: {
      findAllByType: (type: unknown) => RenderedNode[]
      findByType: (type: unknown) => RenderedNode
    }
    unmount: () => void
  }

  let renderer: Renderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('does not emit duplicate-key warnings for repeated persisted event IDs', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    act(() => {
      renderer = create(
        createElement(ConnectionLog, { entries: duplicateEntries })
      ) as unknown as Renderer
    })

    expect(
      consoleError.mock.calls.some(([message]) =>
        String(message).includes('Encountered two children with the same key')
      )
    ).toBe(false)

    consoleError.mockRestore()
  })
})
