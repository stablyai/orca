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

const entries: ConnectionLogEntry[] = [
  { id: 'event-1', ts: 1, level: 'info', message: 'Opening WebSocket' }
]

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

  function renderLog(fillAvailableHeight = false): Renderer {
    act(() => {
      renderer = create(
        createElement(ConnectionLog, { entries, fillAvailableHeight })
      ) as unknown as Renderer
    })
    return renderer as Renderer
  }

  it('keeps the compact height in pairing flows', () => {
    const instance = renderLog()
    const containerStyles = instance.root.findAllByType('View')[0]!.props.style

    expect(containerStyles).toContainEqual({ maxHeight: 240 })
  })

  it('fills the available diagnostics viewport', () => {
    const instance = renderLog(true)
    const containerStyles = instance.root.findAllByType('View')[0]!.props.style
    const scroll = instance.root.findByType('ScrollView')

    expect(containerStyles).toContainEqual({ flex: 1 })
    expect(scroll.props.style).toEqual({ flex: 1 })
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
