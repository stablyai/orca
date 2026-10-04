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

  it('names each known limit source and omits the line for unknown sources', async () => {
    const detailFor = async (limitSource?: string): Promise<string> => {
      alert.mockClear()
      let tree: ReactTestRenderer
      await act(async () => {
        tree = create(
          createElement(ContextPressureDot, {
            pressure: {
              level: 'critical',
              usedPercent: 91,
              usedTokens: 91,
              limitTokens: 100,
              ...(limitSource ? { limitSource } : {})
            } as never
          })
        )
      })
      tree!.root.findByType('Pressable').props.onPress({ stopPropagation: vi.fn() })
      return alert.mock.calls[0][1] as string
    }
    expect(await detailFor('soft-cap')).toContain('Effective limit: soft cap')
    expect(await detailFor('model')).toContain('Effective limit: model maximum')
    expect(await detailFor('provider')).toContain('Effective limit: provider-reported')
    // Forward-compat: an unknown source from a newer desktop must not surface "undefined".
    const unknown = await detailFor('token-budget')
    expect(unknown).not.toContain('undefined')
    expect(unknown).not.toContain('Effective limit')
  })
})
