import { describe, expect, it } from 'vitest'
import { DEFAULT_HOME_LAYOUT, normalizeHomeLayout } from './home-layout'

describe('normalizeHomeLayout', () => {
  it('keeps a saved arrangement as it was saved', () => {
    const saved = {
      order: ['desktops', 'accountUsage', 'jumpBackIn', 'tasks', 'automations', 'stats'],
      hidden: ['stats']
    }
    expect(normalizeHomeLayout(saved)).toEqual(saved)
  })

  it('drops unknown and repeated ids', () => {
    expect(
      normalizeHomeLayout({
        order: ['desktops', 'retired', 'desktops', 7, 'jumpBackIn', 'tasks', 'automations'],
        hidden: ['retired', 'tasks', 'tasks']
      })
    ).toEqual({
      order: ['desktops', 'jumpBackIn', 'tasks', 'automations', 'stats', 'accountUsage'],
      hidden: ['tasks']
    })
  })

  it('slots a section the saved layout predates in after its default neighbour', () => {
    expect(
      normalizeHomeLayout({ order: ['desktops', 'tasks', 'jumpBackIn', 'automations'], hidden: [] })
        .order
    ).toEqual(['desktops', 'tasks', 'jumpBackIn', 'automations', 'stats', 'accountUsage'])
    expect(normalizeHomeLayout({ order: ['stats', 'desktops'], hidden: [] }).order).toEqual([
      'jumpBackIn',
      'stats',
      'accountUsage',
      'desktops',
      'tasks',
      'automations'
    ])
  })

  it('never hides Desktops, which holds the way to pair', () => {
    expect(normalizeHomeLayout({ order: [], hidden: ['desktops', 'stats'] }).hidden).toEqual([
      'stats'
    ])
  })

  it('reads anything else as the default layout', () => {
    for (const corrupt of [null, 'stats', 42, [], { order: 'desktops', hidden: {} }]) {
      expect(normalizeHomeLayout(corrupt)).toEqual(DEFAULT_HOME_LAYOUT)
    }
  })
})
