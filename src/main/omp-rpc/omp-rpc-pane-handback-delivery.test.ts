// XLR-R7-001 (cross-lab review): a completed release must not lose the only
// instruction that recreates the pane's PTY. Main has already deleted the RPC
// session by then, so the pane's adoption probe answers "no session" — if the
// hand-back push also went nowhere (renderer reloaded, listener absent, sender
// destroyed) the pane is left with neither RPC ownership nor a terminal.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getAllWebContents } = vi.hoisted(() => ({ getAllWebContents: vi.fn() }))

vi.mock('electron', () => ({ webContents: { getAllWebContents } }))

import {
  claimOmpRpcPaneHandbacks,
  clearOmpRpcPaneHandbacksForTests,
  publishOmpRpcPaneHandback,
  settleOmpRpcPaneHandback
} from './omp-rpc-pane-handback-delivery'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = `tab-1:${LEAF_ID}`

function makePayload(overrides: Partial<{ paneKey: string; sessionId: string }> = {}) {
  return {
    paneKey: PANE_KEY,
    replacedPtyId: 'pty-1',
    cwd: '/work',
    sessionId: 'session-a',
    ...overrides
  }
}

const RENDERER = 1
const OTHER_RENDERER = 2
const DOCUMENT = 'document-a'

function makeContents(
  isDestroyed = false,
  id = RENDERER
): { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> } {
  return { id, isDestroyed: () => isDestroyed, send: vi.fn() }
}

/** One asking document. Reusing the `webContents` id with a NEW document id is
 *  what a reload looks like; reusing both is the same live listener asking
 *  twice, which must never be re-leased. */
function claim(tabId: string, webContentsId = RENDERER, documentId = DOCUMENT) {
  return claimOmpRpcPaneHandbacks(tabId, webContentsId, documentId)
}

/** The payloads a claim leased, for the assertions that only care about those. */
function claimPayloads(tabId: string, webContentsId = RENDERER, documentId = DOCUMENT) {
  return claim(tabId, webContentsId, documentId).map((claimed) => claimed.payload)
}

beforeEach(() => {
  vi.clearAllMocks()
  clearOmpRpcPaneHandbacksForTests()
  getAllWebContents.mockReturnValue([])
})

describe('OMP RPC pane hand-back delivery', () => {
  it('nudges every live renderer, not just the release requester', () => {
    const first = makeContents()
    const second = makeContents()
    getAllWebContents.mockReturnValue([first, second])

    publishOmpRpcPaneHandback(makePayload())

    expect(first.send).toHaveBeenCalledWith('ompRpcChat:handback', makePayload())
    expect(second.send).toHaveBeenCalledWith('ompRpcChat:handback', makePayload())
  })

  // The failure this module exists for: the only renderer is gone when the
  // bounded release finally proves settle+exit, so the push reaches nobody.
  it('keeps the instruction claimable when no renderer could receive the nudge', () => {
    getAllWebContents.mockReturnValue([makeContents(true)])

    publishOmpRpcPaneHandback(makePayload())

    expect(claimPayloads('tab-1')).toEqual([makePayload()])
  })

  it('never throws a release open when a renderer dies mid-send', () => {
    const dying = {
      isDestroyed: () => false,
      send: vi.fn(() => {
        throw new Error('Object has been destroyed')
      })
    }
    getAllWebContents.mockReturnValue([dying])

    expect(() => publishOmpRpcPaneHandback(makePayload())).not.toThrow()
    expect(claimPayloads('tab-1')).toEqual([makePayload()])
  })

  // The claim is the single consume: several joined releases each nudge, and a
  // respawn per nudge would put two `omp --resume` children on one session.
  it('hands one retained instruction to exactly one claimant', () => {
    publishOmpRpcPaneHandback(makePayload())
    publishOmpRpcPaneHandback(makePayload())

    getAllWebContents.mockReturnValue([makeContents()])

    expect(claimPayloads('tab-1')).toEqual([makePayload()])
    // A second, still-live listener finds it already leased.
    expect(claimPayloads('tab-1', OTHER_RENDERER)).toEqual([])
  })

  it('supersedes an unclaimed instruction with the newer proven identity', () => {
    publishOmpRpcPaneHandback(makePayload())
    publishOmpRpcPaneHandback(makePayload({ sessionId: 'session-b' }))

    expect(claimPayloads('tab-1')).toEqual([makePayload({ sessionId: 'session-b' })])
  })

  it('claims only the asking tab, and every pane of it', () => {
    publishOmpRpcPaneHandback(makePayload())
    publishOmpRpcPaneHandback(makePayload({ paneKey: `tab-1:${OTHER_LEAF_ID}` }))
    publishOmpRpcPaneHandback(makePayload({ paneKey: `tab-2:${LEAF_ID}` }))

    expect(claimPayloads('tab-1')).toEqual([
      makePayload(),
      makePayload({ paneKey: `tab-1:${OTHER_LEAF_ID}` })
    ])
    expect(claimPayloads('tab-2')).toEqual([makePayload({ paneKey: `tab-2:${LEAF_ID}` })])
  })

  // `respawnPtyForOmpRpcChatHandback` refuses an unparseable pane key, so
  // retaining one would leave an entry nothing could ever claim.
  it('nudges but never retains a pane key no renderer could respawn into', () => {
    const contents = makeContents()
    getAllWebContents.mockReturnValue([contents])

    publishOmpRpcPaneHandback(makePayload({ paneKey: 'not-a-pane-key' }))

    expect(contents.send).toHaveBeenCalledTimes(1)
    expect(claimPayloads('not-a-pane-key')).toEqual([])
  })
})

// XLR-R8-001 (cross-lab review, round 8): deleting on claim made the hand-back
// neither reload- nor failure-durable. Between the claim and a proven respawn
// the renderer can reload, unmount, or have `pty.spawn` reject — and main had
// already dropped the only instruction that recreates the pane's PTY, so the
// pane was left with neither RPC ownership nor a terminal and nothing ever
// revisited it. A claim now LEASES; only a settled respawn discards.
describe('OMP RPC pane hand-back leases', () => {
  beforeEach(() => {
    getAllWebContents.mockReturnValue([makeContents()])
  })

  it('keeps the instruction until a respawn is reported', () => {
    publishOmpRpcPaneHandback(makePayload())
    const [leased] = claim('tab-1')

    settleOmpRpcPaneHandback({ paneKey: PANE_KEY, token: leased.token, respawned: true })

    expect(claimPayloads('tab-1')).toEqual([])
  })

  it('returns the instruction when the respawn failed', () => {
    publishOmpRpcPaneHandback(makePayload())
    const [leased] = claim('tab-1')

    settleOmpRpcPaneHandback({ paneKey: PANE_KEY, token: leased.token, respawned: false })

    expect(claimPayloads('tab-1')).toEqual([makePayload()])
  })

  it('nudges a lone listener after a failed respawn so it can retry', () => {
    publishOmpRpcPaneHandback(makePayload())
    const [leased] = claim('tab-1')
    const contents = makeContents()
    getAllWebContents.mockReturnValue([contents])

    settleOmpRpcPaneHandback({ paneKey: PANE_KEY, token: leased.token, respawned: false })

    expect(contents.send).toHaveBeenCalledWith('ompRpcChat:handback', makePayload())
  })

  it('stops immediately re-nudging after bounded failed respawns', () => {
    const contents = makeContents()
    getAllWebContents.mockReturnValue([contents])
    publishOmpRpcPaneHandback(makePayload())

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [leased] = claim('tab-1')
      expect(leased).toBeDefined()
      settleOmpRpcPaneHandback({ paneKey: PANE_KEY, token: leased.token, respawned: false })
    }

    expect(contents.send).toHaveBeenCalledTimes(4)
  })

  it('re-leases to a reloaded document whose predecessor can no longer settle', () => {
    publishOmpRpcPaneHandback(makePayload())
    const [predecessor] = claim('tab-1')

    const [replacement] = claim('tab-1', RENDERER, 'document-b')

    expect(replacement?.payload).toEqual(makePayload())
    settleOmpRpcPaneHandback({ paneKey: PANE_KEY, token: predecessor.token, respawned: true })
    expect(claimPayloads('tab-1', RENDERER, 'document-b')).toEqual([])
  })

  it('lets another window recover a lease whose claimant is gone', () => {
    publishOmpRpcPaneHandback(makePayload())
    claim('tab-1')
    getAllWebContents.mockReturnValue([makeContents(false, OTHER_RENDERER)])

    expect(claimPayloads('tab-1', OTHER_RENDERER)).toEqual([makePayload()])
  })

  // Two `omp --resume` children on one session file is the overlap the
  // take-and-delete used to prevent on its own; the lease still does.
  it('refuses a second live window while the first still holds the lease', () => {
    publishOmpRpcPaneHandback(makePayload())
    claim('tab-1')
    getAllWebContents.mockReturnValue([makeContents(), makeContents(false, OTHER_RENDERER)])

    expect(claimPayloads('tab-1', OTHER_RENDERER)).toEqual([])
  })

  it('never lets a stale settle discard a newer hand-back for the same pane', () => {
    publishOmpRpcPaneHandback(makePayload())
    const [stale] = claim('tab-1')
    publishOmpRpcPaneHandback(makePayload({ sessionId: 'session-b' }))

    settleOmpRpcPaneHandback({ paneKey: PANE_KEY, token: stale.token, respawned: true })

    expect(claimPayloads('tab-1')).toEqual([makePayload({ sessionId: 'session-b' })])
  })

  it('ignores a settle for a pane with nothing retained', () => {
    expect(() =>
      settleOmpRpcPaneHandback({ paneKey: PANE_KEY, token: 'handback-9', respawned: true })
    ).not.toThrow()
  })
})

// XLR-R9-001 (cross-lab review, round 9): the lease was keyed on the asking
// `webContents` id, which is NOT one claimant. The durable listener claims on
// mount AND on every nudge from the same document, so a nudge arriving while
// the first claim's respawn was still in flight was re-leased the same payload
// — two `omp --resume` children writing one session file, with the post-spawn
// staleness reap only able to reap one of them AFTER the forbidden overlap.
describe('OMP RPC pane hand-back single-writer under one document', () => {
  beforeEach(() => {
    getAllWebContents.mockReturnValue([makeContents()])
  })

  it('refuses the same document a second lease while its respawn is in flight', () => {
    publishOmpRpcPaneHandback(makePayload())
    expect(claimPayloads('tab-1')).toEqual([makePayload()])

    // The nudge's claim, arriving before the mount claim's respawn settled.
    expect(claimPayloads('tab-1')).toEqual([])
  })

  // The release is single-flight but the push is not: N joined callers each
  // publish the identical instruction, and replacing the entry dropped the
  // outstanding lease — handing the payload straight back to the claimant
  // still respawning it.
  it('keeps an outstanding lease across a re-published identical instruction', () => {
    publishOmpRpcPaneHandback(makePayload())
    expect(claimPayloads('tab-1')).toEqual([makePayload()])

    publishOmpRpcPaneHandback(makePayload())

    expect(claimPayloads('tab-1')).toEqual([])
  })

  // The refusal must not strand the pane: the holder may still hand it back
  // un-respawned, and the refused claimant has no other signal to look again.
  it('re-nudges a refused claimant once the lease ends un-respawned', () => {
    publishOmpRpcPaneHandback(makePayload())
    const [leased] = claim('tab-1')
    claim('tab-1')
    const contents = makeContents()
    getAllWebContents.mockReturnValue([contents])

    settleOmpRpcPaneHandback({ paneKey: PANE_KEY, token: leased.token, respawned: false })

    expect(contents.send).toHaveBeenCalledWith('ompRpcChat:handback', makePayload())
    expect(claimPayloads('tab-1')).toEqual([makePayload()])
  })

  it('never re-nudges once a respawn actually happened', () => {
    publishOmpRpcPaneHandback(makePayload())
    const [leased] = claim('tab-1')
    claim('tab-1')
    const contents = makeContents()
    getAllWebContents.mockReturnValue([contents])

    settleOmpRpcPaneHandback({ paneKey: PANE_KEY, token: leased.token, respawned: true })

    expect(contents.send).not.toHaveBeenCalled()
    expect(claimPayloads('tab-1')).toEqual([])
  })
})

// Fail closed without an asking document: a `webContents` id alone cannot tell
// a reload from the holder claiming again mid-respawn.
describe('OMP RPC pane hand-back claimant identity', () => {
  it('refuses a claim that names no document', () => {
    publishOmpRpcPaneHandback(makePayload())

    expect(claimOmpRpcPaneHandbacks('tab-1', RENDERER, undefined)).toEqual([])
    expect(claimOmpRpcPaneHandbacks('tab-1', RENDERER, '  ')).toEqual([])
    expect(claimPayloads('tab-1')).toEqual([makePayload()])
  })
})
