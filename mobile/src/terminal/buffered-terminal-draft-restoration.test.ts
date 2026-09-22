import { describe, expect, it } from 'vitest'
import {
  beginBufferedTerminalDraftRestoration,
  invalidateBufferedTerminalDraftRestoration,
  pruneBufferedTerminalDrafts,
  pruneBufferedTerminalDraftRestorations,
  restoreRejectedBufferedTerminalDraft,
  settleBufferedTerminalDraftRestoration,
  updateBufferedTerminalDraft
} from './buffered-terminal-draft-restoration'

describe('buffered terminal draft restoration', () => {
  it('restores the exact rejected draft when the composer is still empty', () => {
    const pendingRestorations = new Map()
    const token = beginBufferedTerminalDraftRestoration(pendingRestorations, 'terminal')
    expect(settleBufferedTerminalDraftRestoration(pendingRestorations, 'terminal', token)).toBe(
      true
    )
    expect(
      restoreRejectedBufferedTerminalDraft({ terminal: '' }, 'terminal', '  echo a–b  ')
    ).toEqual({ terminal: '  echo a–b  ' })
  })

  it('preserves newer text composed while the rejected send was in flight', () => {
    const drafts = { terminal: 'next command' }
    const pendingRestorations = new Map()
    const token = beginBufferedTerminalDraftRestoration(pendingRestorations, 'terminal')
    invalidateBufferedTerminalDraftRestoration(pendingRestorations, 'terminal')
    expect(settleBufferedTerminalDraftRestoration(pendingRestorations, 'terminal', token)).toBe(
      false
    )
    expect(restoreRejectedBufferedTerminalDraft(drafts, 'terminal', 'rejected command')).toBe(
      drafts
    )
  })

  it('clears restoration metadata when an accepted send settles', () => {
    const pendingRestorations = new Map()
    const token = beginBufferedTerminalDraftRestoration(pendingRestorations, 'terminal')

    expect(settleBufferedTerminalDraftRestoration(pendingRestorations, 'terminal', token)).toBe(
      true
    )
    expect(settleBufferedTerminalDraftRestoration(pendingRestorations, 'terminal', token)).toBe(
      false
    )
  })

  it('preserves a later intentional clear while the rejected send was in flight', () => {
    const terminal = 'terminal'
    const rejectedDraft = 'rejected command'
    const pendingRestorations = new Map()
    const token = beginBufferedTerminalDraftRestoration(pendingRestorations, terminal)
    let drafts = { [terminal]: rejectedDraft }
    drafts = updateBufferedTerminalDraft(drafts, terminal, '')
    invalidateBufferedTerminalDraftRestoration(pendingRestorations, terminal)
    drafts = updateBufferedTerminalDraft(drafts, terminal, 'new command')
    drafts = updateBufferedTerminalDraft(drafts, terminal, '')

    if (settleBufferedTerminalDraftRestoration(pendingRestorations, terminal, token)) {
      drafts = restoreRejectedBufferedTerminalDraft(drafts, terminal, rejectedDraft)
    }
    expect(drafts).toEqual({ [terminal]: '' })
  })

  it('restores a rejection to terminal A after switching to terminal B', () => {
    const terminalA = 'terminal-a'
    const terminalB = 'terminal-b'
    const rejectedDraft = '  echo exact–text  '
    let activeHandle = terminalA
    const sendOrigin = activeHandle
    const pendingRestorations = new Map()
    const token = beginBufferedTerminalDraftRestoration(pendingRestorations, sendOrigin)
    let drafts = { [terminalA]: rejectedDraft, [terminalB]: 'new command for B' }
    drafts = updateBufferedTerminalDraft(drafts, sendOrigin, '')
    activeHandle = terminalB

    if (settleBufferedTerminalDraftRestoration(pendingRestorations, sendOrigin, token)) {
      drafts = restoreRejectedBufferedTerminalDraft(drafts, sendOrigin, rejectedDraft)
    }

    expect(activeHandle).toBe(terminalB)
    expect(drafts).toEqual({
      [terminalA]: rejectedDraft,
      [terminalB]: 'new command for B'
    })
  })

  it('prunes drafts when their terminal lifetime ends', () => {
    const liveDrafts = { live: 'keep' }
    expect(pruneBufferedTerminalDrafts(liveDrafts, new Set(['live']))).toBe(liveDrafts)
    expect(
      pruneBufferedTerminalDrafts({ live: 'keep', closed: 'drop' }, new Set(['live']))
    ).toEqual({ live: 'keep' })

    const pendingRestorations = new Map()
    const liveToken = beginBufferedTerminalDraftRestoration(pendingRestorations, 'live')
    const closedToken = beginBufferedTerminalDraftRestoration(pendingRestorations, 'closed')
    pruneBufferedTerminalDraftRestorations(pendingRestorations, new Set(['live']))
    expect(settleBufferedTerminalDraftRestoration(pendingRestorations, 'live', liveToken)).toBe(
      true
    )
    expect(settleBufferedTerminalDraftRestoration(pendingRestorations, 'closed', closedToken)).toBe(
      false
    )
  })
})
