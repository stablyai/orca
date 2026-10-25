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
    const first = v.openPhoneSession('phone', 'repo-1::/tmp/a/')
    const second = v.openPhoneSession('phone', WT)
    expect(v.isViewing(WT, OTHER_PANE)).toBe(true)
    first()
    first()
    expect(v.isViewing(WT, PANE)).toBe(true)
    second()
    expect(v.isViewing(WT, PANE)).toBe(false)
  })

  it('stops seeing a phone’s session while it reports away, and again when it returns', () => {
    const { viewers: v } = viewers()
    v.openPhoneSession('phone', WT)
    v.openPhoneSession('phone', 'repo-1::/tmp/a/')
    expect(v.showsWorkspace('phone', WT)).toBe(true)
    v.reportClientView('phone', { workspaceIds: [], tabIds: [], presentForMs: 0 })
    expect(v.isViewing(WT, PANE)).toBe(false)
    expect(v.showsWorkspace('phone', WT)).toBe(false)
    expect(v.shownPhoneSessions('phone')).toEqual([])
    v.reportClientView('phone', { workspaceIds: [], tabIds: [], presentForMs: null })
    expect(v.isViewing(WT, PANE)).toBe(true)
    expect(v.shownPhoneSessions('phone')).toEqual([WT])
  })

  it('sees only the session a phone names as focused, not one it left behind another screen', () => {
    const { viewers: v } = viewers()
    const OTHER = 'repo-1::/tmp/b'
    v.openPhoneSession('phone', WT)
    v.openPhoneSession('phone', OTHER)
    v.reportClientView('phone', { workspaceIds: [OTHER], tabIds: [], presentForMs: null })
    expect(v.isViewing(WT, PANE)).toBe(false)
    // Every pane of the named session's workspace, not just tabs a window would list.
    expect(v.isViewing(OTHER, PANE)).toBe(true)
    expect(v.shownPhoneSessions('phone')).toEqual([OTHER])
    expect(v.showsWorkspace('phone', 'repo-1::/tmp/a/')).toBe(false)
    // The session route behind settings: away, though the app is in the foreground.
    v.reportClientView('phone', { workspaceIds: [], tabIds: [], presentForMs: 0 })
    expect(v.isViewing(OTHER, PANE)).toBe(false)
  })

  it('keeps an older phone that never reports as looking until its session closes', () => {
    const { clock, viewers: v } = viewers()
    const close = v.openPhoneSession('old-phone', WT)
    clock.now += 24 * 60 * 60 * 1000
    expect(v.isViewing(WT, PANE)).toBe(true)
    close()
    expect(v.isViewing(WT, PANE)).toBe(false)
  })

  it('judges each phone by its own presence', () => {
    const { viewers: v } = viewers()
    v.openPhoneSession('away-phone', WT)
    v.reportClientView('away-phone', { workspaceIds: [], tabIds: [], presentForMs: 0 })
    expect(v.isViewing(WT, PANE)).toBe(false)
    const close = v.openPhoneSession('here-phone', WT)
    expect(v.isViewing(WT, PANE)).toBe(true)
    close()
    expect(v.isViewing(WT, PANE)).toBe(false)
    // A connection with no id (in-process) cannot report, so it is always present.
    v.openPhoneSession(null, WT)
    expect(v.isViewing(WT, PANE)).toBe(true)
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
