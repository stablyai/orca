import { describe, expect, it } from 'vitest'
import type { HudState, NotificationInboxEntry } from '../state/hud-store'
import { DEFAULT_ASK_OPTION_COUNT, renderAskScreen } from './ask-screen'

function fixtureState(entries: NotificationInboxEntry[], selectedOption = 0): HudState {
  return {
    connection: { hostId: 'h1', state: 'connected', compat: null },
    hosts: [],
    dashboard: { rows: [], fetchedAt: 0, stale: false },
    inbox: { entries },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askAnswered: null,
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
      footer: 'click=send  2tap=back'
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

  it('falls back to a generic title when the notification is missing from the inbox', () => {
    const page = renderAskScreen(fixtureState([], 0))
    expect(page.layout).toBe('text')
    if (page.layout !== 'text') {
      throw new Error('expected text layout')
    }
    expect(page.header).toBe('Orca · Needs input')
  })
})
