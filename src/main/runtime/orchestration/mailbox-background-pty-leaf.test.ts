import { describe, expect, it } from 'vitest'
import {
  mailboxLeafForBackgroundPtyKey,
  mailboxLeafFromBackgroundPty,
  type BackgroundPtyMailboxSource
} from './mailbox-background-pty-leaf'

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'

function backgroundPty(
  overrides: Partial<BackgroundPtyMailboxSource> = {}
): BackgroundPtyMailboxSource {
  return {
    ptyId: 'pty-bg',
    connected: true,
    tabId: TAB_ID,
    paneKey: `${TAB_ID}:${LEAF_ID}`,
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true,
    lastOscTitle: 'Codex done',
    managementTitle: null,
    title: 'reviewer',
    ...overrides
  }
}

describe('mailboxLeafFromBackgroundPty', () => {
  it('rebuilds a writable mailbox leaf from the retained pane identity', () => {
    expect(mailboxLeafFromBackgroundPty(backgroundPty())).toEqual({
      tabId: TAB_ID,
      leafId: LEAF_ID,
      ptyId: 'pty-bg',
      writable: true,
      lastAgentStatus: 'idle',
      lastAgentStatusObservedLive: true,
      lastOscTitle: 'Codex done',
      paneTitle: 'reviewer'
    })
  })

  it('refuses disconnected or pane-less background PTYs', () => {
    expect(mailboxLeafFromBackgroundPty(backgroundPty({ connected: false }))).toBeNull()
    expect(mailboxLeafFromBackgroundPty(backgroundPty({ paneKey: null }))).toBeNull()
    expect(mailboxLeafFromBackgroundPty(backgroundPty({ tabId: 'other-tab' }))).toBeNull()
  })
})

describe('mailboxLeafForBackgroundPtyKey', () => {
  it('matches the runtime leaf key, not the pane-key delimiter', () => {
    const leaf = mailboxLeafForBackgroundPtyKey(
      `${TAB_ID}::${LEAF_ID}`,
      [backgroundPty()],
      (tabId, leafId) => `${tabId}::${leafId}`
    )
    expect(leaf?.ptyId).toBe('pty-bg')
    expect(
      mailboxLeafForBackgroundPtyKey(
        `${TAB_ID}:${LEAF_ID}`,
        [backgroundPty()],
        (tabId, leafId) => `${tabId}::${leafId}`
      )
    ).toBeNull()
  })
})
