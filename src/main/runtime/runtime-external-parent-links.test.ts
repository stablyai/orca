import { describe, expect, it } from 'vitest'
import { RuntimeExternalParentLinks } from './runtime-external-parent-links'

describe('external agent parent links', () => {
  it('replaces and deletes links without exposing mutable registry entries', () => {
    const links = new RuntimeExternalParentLinks()
    const link = { parentPaneKey: 'root:leaf', taskId: 'jcode-spawn:child' }
    links.set('child:leaf', link)
    link.parentPaneKey = 'other:leaf'
    const entries = links.entries()
    expect(entries).toEqual([
      ['child:leaf', { parentPaneKey: 'root:leaf', taskId: 'jcode-spawn:child' }]
    ])
    entries[0][1].parentPaneKey = 'changed:leaf'
    expect(links.entries()[0][1].parentPaneKey).toBe('root:leaf')
    links.set('child:leaf', { parentPaneKey: 'new:leaf', taskId: 'new' })
    expect(links.entries()).toHaveLength(1)
    links.delete('child:leaf')
    links.delete('child:leaf')
    expect(links.entries()).toEqual([])
  })
})
