import { describe, expect, it } from 'vitest'
import { preservePendingSessionTab } from './pending-session-tab-preservation'

type Tab = {
  id: string
  isActive: boolean
  terminal?: string
}

describe('preservePendingSessionTab', () => {
  it('keeps a locally created tab active while an older snapshot has not seen it', () => {
    const oldTab: Tab = { id: 'old', isActive: true, terminal: 'term-old' }
    const created: Tab = { id: 'created', isActive: true, terminal: 'term-new' }

    expect(preservePendingSessionTab([oldTab], [oldTab, created], created.id)).toEqual([
      { ...oldTab, isActive: false },
      created
    ])
  })

  it('uses the server snapshot once it contains the pending tab', () => {
    const created: Tab = { id: 'created', isActive: true, terminal: 'term-new' }

    expect(preservePendingSessionTab([created], [created], created.id)).toEqual([created])
  })

  it('does not resurrect a tab that is absent from both local and server state', () => {
    const oldTab: Tab = { id: 'old', isActive: true, terminal: 'term-old' }

    expect(preservePendingSessionTab([oldTab], [oldTab], 'missing')).toEqual([oldTab])
  })
})
