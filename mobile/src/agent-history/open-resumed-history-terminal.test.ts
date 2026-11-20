import { describe, expect, it, vi } from 'vitest'
import { openResumedHistoryTerminal } from './open-resumed-history-terminal'

import { reviewCreatedTerminalSchema } from '../source-control/review/terminal-delivery/review-terminal-reply-schema'
import { notificationPaneTab } from '../session/tabs/notification-pane-tab'
import type { MobileSessionTab } from '../session/tabs/mobile-session-tabs'

vi.mock('expo-router', () => ({}))

const LEAF = '11111111-1111-4111-8111-111111111111'
const resumed = reviewCreatedTerminalSchema.parse({
  tab: { type: 'terminal', id: 'tab-1', terminal: 'term-1', parentTabId: 'group', leafId: LEAF }
})

function open(overrides: Partial<Parameters<typeof openResumedHistoryTerminal>[0]> = {}) {
  const router = { back: vi.fn(), replace: vi.fn() }
  const shellOpen = vi.fn()
  openResumedHistoryTerminal({
    router,
    sessionBelow: undefined,
    shell: { returns: () => true, open: shellOpen },
    hostId: 'host 1',
    executionHost: undefined,
    worktreeId: 'wt/1',
    resumed,
    fromSession: true,
    ...overrides
  })
  return { ...router, shellOpen }
}

describe('openResumedHistoryTerminal', () => {
  it('hands the terminal to the session below in this document', () => {
    const onResumedTerminal = vi.fn()
    const calls = open({ sessionBelow: { onResumedTerminal } })
    expect(onResumedTerminal).toHaveBeenCalledWith('term-1')
    expect(calls.back).toHaveBeenCalledOnce()
    expect(calls.replace).not.toHaveBeenCalled()
  })

  it('asks the shell to select the resumed pane on the session entry', () => {
    const calls = open()
    const href = `/h/host%201/session/wt%2F1?paneKey=${encodeURIComponent(`group:${LEAF}`)}`
    expect(calls.shellOpen).toHaveBeenCalledWith(href)
    expect(calls.replace).not.toHaveBeenCalled()
    const inventory: MobileSessionTab[] = [
      {
        type: 'terminal',
        id: 'tab-1',
        title: 'Terminal',
        isActive: false,
        terminal: 'term-1',
        parentTabId: 'group',
        leafId: LEAF
      }
    ]
    const paneKey = new URLSearchParams(href.split('?')[1]).get('paneKey') ?? ''
    expect(notificationPaneTab(inventory, paneKey)).toBe(inventory[0])
  })

  it("keeps the execution host on the shell href so the shell finds that server's session entry", () => {
    const calls = open({ executionHost: 'ssh:box' })
    const href = String(calls.shellOpen.mock.calls[0]?.[0])
    expect(new URLSearchParams(href.split('?')[1]).get('executionHost')).toBe('ssh:box')
    expect(href.match(/executionHost=/g)).toHaveLength(1)
  })

  it('goes Back when the shell would push a second session entry or no pane is named', () => {
    expect(open({ shell: { returns: () => false, open: vi.fn() } }).back).toHaveBeenCalledOnce()
    expect(open({ resumed: { id: 'tab-1', terminal: 'term-1' } }).back).toHaveBeenCalledOnce()
  })

  it('opens another session without a pane on older shells', () => {
    const calls = open({ fromSession: false, shell: null })
    expect(calls.replace).toHaveBeenCalledWith('/h/host%201/session/wt%2F1')
  })
})
