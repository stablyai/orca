import { describe, expect, it } from 'vitest'
import type { AskInteraction, HudState, NotificationInboxEntry } from '../state/hud-store'
import { DEFAULT_ASK_OPTION_COUNT, renderAskScreen } from './ask-screen'

function fixtureState(
  entries: NotificationInboxEntry[],
  selectedOption = 0,
  askInteraction: AskInteraction = null
): HudState {
  return {
    connection: { hostId: 'h1', state: 'connected', compat: null },
    hosts: [],
    dashboard: { rows: [], fetchedAt: 0, stale: false },
    inbox: { entries },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askInteraction,
    nav: {
      stack: [{ screen: 'ask', hostId: 'h1', notificationId: 'n1', selectedOption }],
      exitDialogArmed: false
    }
  }
}

const entry: NotificationInboxEntry = {
  notificationId: 'n1',
  title: 'Permission needed',
  body: 'Allow file write?',
  worktreeId: 'wt-1',
  receivedAt: 0,
  kind: 'ask'
}

describe('DEFAULT_ASK_OPTION_COUNT', () => {
  it('is 3, matching the spec example strip `1 2 3 Enter Esc`', () => {
    expect(DEFAULT_ASK_OPTION_COUNT).toBe(3)
  })
})

describe('renderAskScreen', () => {
  it('renders the notification title/body plus an option strip with the cursor on slot 0', () => {
    const page = renderAskScreen(fixtureState([entry], 0))
    expect(page).toEqual({
      layout: 'text',
      header: 'Orca · Permission needed',
      body: 'Allow file write?\n> 1    2    3    Enter    Esc',
      footer: 'scroll=choose  click=send  2tap=back'
    })
  })

  it('moves the cursor glyph to the highlighted slot', () => {
    const page = renderAskScreen(fixtureState([entry], 3))
    expect(page.layout).toBe('text')
    if (page.layout !== 'text') {
      throw new Error('expected text layout')
    }
    expect(page.body).toBe('Allow file write?\n  1    2    3  > Enter    Esc')
  })

  it('falls back to a generic title/body when the notification is missing from the inbox (finding #14: synthesized ask)', () => {
    const page = renderAskScreen(fixtureState([], 0))
    expect(page.layout).toBe('text')
    if (page.layout !== 'text') {
      throw new Error('expected text layout')
    }
    expect(page.header).toBe('Orca · Needs input')
    expect(page.body).toBe('Waiting on input — no details yet\n> 1    2    3    Enter    Esc')
  })

  // HIGH #5: a 1200-char single-line body (no newlines) previously survived pagination as one
  // giant unsplit "page", whose tail — where the option strip lives — buildHudPage's separate
  // hard BODY_MAX_CHARS(1000) truncation then silently cut off, leaving send stuck enabled with
  // no visible way to act on it.
  describe('finding #5: a very long unbroken body never drops the option strip', () => {
    const longEntry: NotificationInboxEntry = {
      notificationId: 'n1',
      title: 'Permission needed',
      body: 'x'.repeat(1200),
      worktreeId: 'wt-1',
      receivedAt: 0,
      kind: 'ask'
    }

    it('keeps the option strip intact and indicates the omitted body content', () => {
      const page = renderAskScreen(fixtureState([longEntry], 0))
      expect(page.layout).toBe('text')
      if (page.layout !== 'text') {
        throw new Error('expected text layout')
      }
      expect(page.body).toContain('> 1    2    3    Enter    Esc')
      expect(page.body.length).toBeLessThan(1000)
      expect(page.footer).toContain('⋯more')
    })

    it('truncates the BODY, never the strip, when send is enabled', () => {
      const page = renderAskScreen(fixtureState([longEntry], 1))
      expect(page.layout).toBe('text')
      if (page.layout !== 'text') {
        throw new Error('expected text layout')
      }
      // Slot 1 highlighted, exactly as buildOptionStrip renders it — proves the strip survived
      // completely intact, not just a fragment of it.
      expect(page.body.endsWith('  1  > 2    3    Enter    Esc')).toBe(true)
    })
  })

  describe('askInteraction footer (findings #2/#3/#6)', () => {
    it.each([
      ['sending', 'Sending…'],
      ['checking', 'Sent — checking…'],
      ['stalled', 'Sent — check phone'],
      ['failed', 'Not sent — click to retry'],
      ['unresolved', 'Delivery unknown — check phone'],
      ['answered', 'answered ✓  2tap=back']
    ] as const)('renders the %s phase', (phase, footer) => {
      const page = renderAskScreen(
        fixtureState([entry], 0, {
          hostId: 'h1',
          notificationId: 'n1',
          worktreeId: 'wt-1',
          phase,
          updatedAt: 0
        })
      )
      expect(page.footer).toBe(footer)
    })

    it('ignores an interaction for a different notification', () => {
      const page = renderAskScreen(
        fixtureState([entry], 0, {
          hostId: 'h1',
          notificationId: 'other',
          worktreeId: 'wt-2',
          phase: 'sending',
          updatedAt: 0
        })
      )
      expect(page.footer).toBe('scroll=choose  click=send  2tap=back')
    })

    it('HIGH #3: ignores an interaction left over from a different host', () => {
      const page = renderAskScreen(
        fixtureState([entry], 0, {
          hostId: 'h2',
          notificationId: 'n1',
          worktreeId: 'wt-1',
          phase: 'sending',
          updatedAt: 0
        })
      )
      expect(page.footer).toBe('scroll=choose  click=send  2tap=back')
    })

    it('replaces the option strip with "Options unavailable" when failed/unresolved/stalled (finding #8)', () => {
      for (const phase of ['failed', 'unresolved', 'stalled'] as const) {
        const page = renderAskScreen(
          fixtureState([entry], 0, {
            hostId: 'h1',
            notificationId: 'n1',
            worktreeId: 'wt-1',
            phase,
            updatedAt: 0
          })
        )
        expect(page.layout).toBe('text')
        if (page.layout !== 'text') {
          throw new Error('expected text layout')
        }
        expect(page.body).toBe('Allow file write?\nOptions unavailable — check phone')
      }
    })
  })
})
