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

  describe('askInteraction footer (findings #2/#3/#12)', () => {
    it.each([
      ['sending', 'Sending…'],
      ['checking', 'Sent — checking…'],
      ['failed', 'Not sent — click to retry'],
      ['unresolved', 'Delivery unknown — check phone'],
      ['answered', 'answered ✓  2tap=back']
    ] as const)('renders the %s phase', (phase, footer) => {
      const page = renderAskScreen(
        fixtureState([entry], 0, { notificationId: 'n1', worktreeId: 'wt-1', phase, updatedAt: 0 })
      )
      expect(page.footer).toBe(footer)
    })

    it('ignores an interaction for a different notification', () => {
      const page = renderAskScreen(
        fixtureState([entry], 0, {
          notificationId: 'other',
          worktreeId: 'wt-2',
          phase: 'sending',
          updatedAt: 0
        })
      )
      expect(page.footer).toBe('scroll=choose  click=send  2tap=back')
    })

    it('replaces the option strip with "Options unavailable" when failed/unresolved (finding #8)', () => {
      const failed = renderAskScreen(
        fixtureState([entry], 0, {
          notificationId: 'n1',
          worktreeId: 'wt-1',
          phase: 'failed',
          updatedAt: 0
        })
      )
      expect(failed.layout).toBe('text')
      if (failed.layout !== 'text') {
        throw new Error('expected text layout')
      }
      expect(failed.body).toBe('Allow file write?\nOptions unavailable — check phone')

      const unresolved = renderAskScreen(
        fixtureState([entry], 0, {
          notificationId: 'n1',
          worktreeId: 'wt-1',
          phase: 'unresolved',
          updatedAt: 0
        })
      )
      expect(unresolved.layout).toBe('text')
      if (unresolved.layout !== 'text') {
        throw new Error('expected text layout')
      }
      expect(unresolved.body).toBe('Allow file write?\nOptions unavailable — check phone')
    })
  })
})
