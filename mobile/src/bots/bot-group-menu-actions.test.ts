import { describe, expect, it, vi } from 'vitest'
import { botCreateMenuActions, botGroupMenuActions } from './bot-group-menu-actions'

vi.mock('lucide-react-native', () => ({ Bot: 'Bot', Users: 'Users' }))

const t = (_key: string, fallback: string) => fallback

describe('bot group menus', () => {
  it('opens New bot and New group only after the menu has closed', () => {
    const actions = botCreateMenuActions({
      t,
      botCount: 2,
      hostLabel: 'Studio Mac',
      onNewBot: vi.fn(),
      onNewGroup: vi.fn()
    })
    expect(actions.map((action) => [action.label, action.closeBeforePress])).toEqual([
      ['New bot', true],
      ['New group', true]
    ])
    expect(actions[1]?.disabled).toBe(false)
  })

  it('offers New group from two bots on this computer, and says so before', () => {
    const one = botCreateMenuActions({
      t: (_key: string, fallback: string, values?: Record<string, unknown>) =>
        fallback.replace('{{host}}', String(values?.host)),
      botCount: 1,
      hostLabel: 'Studio Mac',
      onNewBot: vi.fn(),
      onNewGroup: vi.fn()
    })
    expect(one[1]?.disabled).toBe(true)
    expect(one[1]?.hint).toContain('Studio Mac')
  })

  it('opens Manage members and Delete only after the menu has closed', () => {
    const actions = botGroupMenuActions({ t, onManageMembers: vi.fn(), onDelete: vi.fn() })
    expect(actions.map((action) => [action.label, action.closeBeforePress])).toEqual([
      ['Manage members…', true],
      ['Delete group…', true]
    ])
  })
})
