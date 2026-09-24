import { describe, expect, it } from 'vitest'
import {
  RETIRED_TERMINAL_PANE_HINT_ERROR,
  resolveHintedTerminalPaneIdentity
} from './retired-terminal-pane-hint-gate'
import {
  MAX_RETIRED_TERMINAL_PANE_RECORDS,
  RetiredTerminalPaneLedger
} from './retired-terminal-pane-ledger'

const WORKTREE_ID = 'repo-1::/tmp/worktree-a'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const publishesNothing = (): boolean => false

function ledgerWithRetiredPane(leafId = LEAF_ID): RetiredTerminalPaneLedger {
  const ledger = new RetiredTerminalPaneLedger()
  ledger.record(WORKTREE_ID, 'tab-1', leafId)
  return ledger
}

function resolve(args: {
  hintedTabId?: string
  hintedLeafId?: string
  retiredPanes?: RetiredTerminalPaneLedger
  isSurfacePublished?: (tabId: string, leafId: string) => boolean
}): { tabId: string; leafId: string } {
  return resolveHintedTerminalPaneIdentity(
    { tabId: args.hintedTabId, leafId: args.hintedLeafId },
    {
      worktreeId: WORKTREE_ID,
      retiredPanes: args.retiredPanes ?? new RetiredTerminalPaneLedger(),
      isSurfacePublished: args.isSurfacePublished ?? publishesNothing
    }
  )
}

describe('resolveHintedTerminalPaneIdentity', () => {
  it('refuses a hint for a pane the host retired and no longer publishes', () => {
    expect(() =>
      resolve({
        hintedTabId: 'tab-1',
        hintedLeafId: LEAF_ID,
        retiredPanes: ledgerWithRetiredPane()
      })
    ).toThrow(RETIRED_TERMINAL_PANE_HINT_ERROR)
  })

  // A shell exiting under a tab the user kept open also records a retirement; once the host
  // republishes that surface the pane must still restart in place.
  it('adopts a retired pane the host publishes again', () => {
    expect(
      resolve({
        hintedTabId: 'tab-1',
        hintedLeafId: LEAF_ID,
        retiredPanes: ledgerWithRetiredPane(),
        isSurfacePublished: (tabId, leafId) => tabId === 'tab-1' && leafId === LEAF_ID
      })
    ).toEqual({ tabId: 'tab-1', leafId: LEAF_ID })
  })

  // Clearing it here would let a spawn that then fails hand the next replay the pane anyway; only
  // registerPty, which proves a PTY bound to it, may forget a retirement.
  it('leaves the ledger untouched when it adopts a retired pane', () => {
    const retiredPanes = ledgerWithRetiredPane()

    resolve({
      hintedTabId: 'tab-1',
      hintedLeafId: LEAF_ID,
      retiredPanes,
      isSurfacePublished: () => true
    })

    expect(retiredPanes.has(WORKTREE_ID, 'tab-1', LEAF_ID)).toBe(true)
  })

  it('adopts a hint the host holds no retirement for', () => {
    expect(resolve({ hintedTabId: 'tab-1', hintedLeafId: LEAF_ID })).toEqual({
      tabId: 'tab-1',
      leafId: LEAF_ID
    })
  })

  it('scopes the refusal to the exact pane key', () => {
    const retiredPanes = ledgerWithRetiredPane()

    expect(resolve({ hintedTabId: 'tab-1', hintedLeafId: OTHER_LEAF_ID, retiredPanes })).toEqual({
      tabId: 'tab-1',
      leafId: OTHER_LEAF_ID
    })
    expect(resolve({ hintedTabId: 'tab-2', hintedLeafId: LEAF_ID, retiredPanes })).toEqual({
      tabId: 'tab-2',
      leafId: LEAF_ID
    })
  })

  it('mints a fresh identity for an absent or unusable hint', () => {
    const retiredPanes = ledgerWithRetiredPane()

    for (const hint of [
      {},
      { hintedTabId: 'tab-1' },
      { hintedLeafId: LEAF_ID },
      // A renderer-local numeric pane id is not a durable leaf id.
      { hintedTabId: 'tab-1', hintedLeafId: 'pane:1' }
    ]) {
      const identity = resolve({ ...hint, retiredPanes })
      expect(identity.tabId).toMatch(UUID_RE)
      expect(identity.leafId).toMatch(UUID_RE)
    }
  })
})

describe('RetiredTerminalPaneLedger', () => {
  it('isolates records by worktree, tab and leaf', () => {
    const ledger = ledgerWithRetiredPane()

    expect(ledger.has(WORKTREE_ID, 'tab-1', LEAF_ID)).toBe(true)
    expect(ledger.has(WORKTREE_ID, 'tab-1', OTHER_LEAF_ID)).toBe(false)
    expect(ledger.has(WORKTREE_ID, 'tab-2', LEAF_ID)).toBe(false)
    expect(ledger.has('repo-1::/tmp/worktree-b', 'tab-1', LEAF_ID)).toBe(false)
  })

  it('forgets one pane without disturbing its siblings', () => {
    const ledger = ledgerWithRetiredPane()
    ledger.record(WORKTREE_ID, 'tab-1', OTHER_LEAF_ID)

    ledger.forget(WORKTREE_ID, 'tab-1', LEAF_ID)

    expect(ledger.has(WORKTREE_ID, 'tab-1', LEAF_ID)).toBe(false)
    expect(ledger.has(WORKTREE_ID, 'tab-1', OTHER_LEAF_ID)).toBe(true)
  })

  it('evicts the oldest records past its cap', () => {
    const ledger = new RetiredTerminalPaneLedger()
    for (let index = 0; index <= MAX_RETIRED_TERMINAL_PANE_RECORDS; index += 1) {
      ledger.record(WORKTREE_ID, `tab-${index}`, LEAF_ID)
    }

    expect(ledger.size).toBe(MAX_RETIRED_TERMINAL_PANE_RECORDS)
    expect(ledger.has(WORKTREE_ID, 'tab-0', LEAF_ID)).toBe(false)
    expect(ledger.has(WORKTREE_ID, `tab-${MAX_RETIRED_TERMINAL_PANE_RECORDS}`, LEAF_ID)).toBe(true)
  })
})
