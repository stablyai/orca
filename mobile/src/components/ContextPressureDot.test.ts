import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextPressureDot } from './ContextPressureDot'

const { alert } = vi.hoisted(() => ({ alert: vi.fn() }))

vi.mock('react-native', () => ({
  Alert: { alert },
  Pressable: 'Pressable',
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))

describe('ContextPressureDot', () => {
  beforeEach(() => alert.mockClear())

  it('opens details without activating a containing row', async () => {
    let tree: ReactTestRenderer
    await act(async () => {
      tree = create(
        createElement(ContextPressureDot, {
          pressure: { level: 'warning', usedPercent: 80, usedTokens: 80, limitTokens: 100 }
        })
      )
    })
    const stopPropagation = vi.fn()

    tree!.root.findByType('Pressable').props.onPress({ stopPropagation })

    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(alert).toHaveBeenCalledOnce()
  })
})
