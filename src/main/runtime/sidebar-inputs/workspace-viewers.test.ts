import { describe, expect, it } from 'vitest'
import { WorkspaceViewers } from './workspace-viewers'

const WT = 'repo-1::/tmp/a'
const PANE = 'tab-a:22222222-2222-4222-8222-222222222222'
const OTHER_PANE = 'tab-b:33333333-3333-4333-8333-333333333333'

function viewers() {
  const clock = { now: 1_000 }
  return { clock, viewers: new WorkspaceViewers(() => clock.now) }
}

describe('WorkspaceViewers', () => {
  it('sees a pane whose tab a client shows, and a workspace only for news with no pane', () => {
    const { viewers: v } = viewers()
    expect(
      v.reportClientView('c1', { workspaceIds: [WT], tabIds: ['tab-a'], presentForMs: null })
    ).toBe(true)
    expect(v.isViewing(WT, PANE)).toBe(true)
    expect(v.isViewing(WT, OTHER_PANE)).toBe(false)
    expect(v.isViewing(WT, null)).toBe(true)
    expect(v.isViewing('repo-1::/tmp/b', null)).toBe(false)
    // A later report replaces the view and needs no second tie to the connection.
    expect(v.reportClientView('c1', { workspaceIds: [], tabIds: [], presentForMs: null })).toBe(
      false
    )
    expect(v.isViewing(WT, PANE)).toBe(false)
  })

  it('stops seeing once the user’s presence lapses or the client goes', () => {
    const { clock, viewers: v } = viewers()
    v.reportClientView('c1', { workspaceIds: [WT], tabIds: ['tab-a'], presentForMs: 500 })
    expect(v.isViewing(WT, PANE)).toBe(true)
    clock.now += 500
    expect(v.isViewing(WT, PANE)).toBe(false)

    v.reportClientView('c1', { workspaceIds: [WT], tabIds: ['tab-a'], presentForMs: null })
    v.dropClient('c1')
    expect(v.isViewing(WT, PANE)).toBe(false)
  })

  it('sees every pane of a workspace a phone holds open, by any spelling of its path', () => {
    const { viewers: v } = viewers()
    const first = v.openPhoneSession('repo-1::/tmp/a/')
    const second = v.openPhoneSession(WT)
    expect(v.isViewing(WT, OTHER_PANE)).toBe(true)
    first()
    first()
    expect(v.isViewing(WT, PANE)).toBe(true)
    second()
    expect(v.isViewing(WT, PANE)).toBe(false)
  })

  it('counts everything as seen while an older desktop that raises the flag itself is connected', () => {
    const { viewers: v } = viewers()
    v.noteSelfRaisingClient('old-desktop')
    expect(v.isViewing(WT, PANE)).toBe(true)
    expect(v.isViewing('repo-1::/tmp/b', null)).toBe(true)
    v.dropClient('old-desktop')
    expect(v.isViewing(WT, PANE)).toBe(false)
  })
})
