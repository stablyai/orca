import { describe, expect, it } from 'vitest'
import {
  getTerminalRecordsFromSessionTabs,
  mergeTerminalListWithKnownRecords,
  mobileSessionTabsEqual,
  type MobileTerminalSessionTab,
  type TerminalRecord
} from './mobile-terminal-records'

const lightTheme = {
  mode: 'light' as const,
  theme: {
    background: '#ffffff',
    foreground: '#111111'
  }
}

const darkTheme = {
  mode: 'dark' as const,
  theme: {
    background: '#111111',
    foreground: '#eeeeee'
  }
}

describe('mobile terminal records', () => {
  it('keeps session-tab terminal themes when terminal.list omits them', () => {
    const terminalList: TerminalRecord[] = [
      { handle: 'pty-1', title: 'Terminal', isActive: true },
      { handle: 'pty-2', title: 'Logs', isActive: false }
    ]
    const currentTerminals: TerminalRecord[] = [
      { handle: 'pty-1', title: 'Terminal', terminalTheme: darkTheme, isActive: true }
    ]
    const sessionTabs: MobileTerminalSessionTab[] = [
      {
        type: 'terminal',
        id: 'term-1::leaf-1',
        title: 'Terminal',
        terminal: 'pty-1',
        terminalTheme: lightTheme,
        isActive: true
      }
    ]

    expect(mergeTerminalListWithKnownRecords(terminalList, currentTerminals, sessionTabs)).toEqual([
      { handle: 'pty-1', title: 'Terminal', terminalTheme: lightTheme, isActive: true },
      { handle: 'pty-2', title: 'Logs', isActive: false }
    ])
  })

  it('falls back to the current terminal theme while waiting for session tabs', () => {
    const terminalList: TerminalRecord[] = [{ handle: 'pty-1', title: 'Terminal', isActive: true }]
    const currentTerminals: TerminalRecord[] = [
      { handle: 'pty-1', title: 'Terminal', terminalTheme: darkTheme, isActive: true }
    ]

    expect(mergeTerminalListWithKnownRecords(terminalList, currentTerminals, [])).toEqual([
      { handle: 'pty-1', title: 'Terminal', terminalTheme: darkTheme, isActive: true }
    ])
  })

  it('ignores pending terminal tabs without a handle', () => {
    expect(
      getTerminalRecordsFromSessionTabs([
        {
          type: 'terminal',
          id: 'pending',
          title: 'Terminal',
          terminal: null,
          terminalTheme: lightTheme,
          isActive: true
        }
      ])
    ).toEqual([])
  })

  it('treats terminal agent-status changes as session-tab changes', () => {
    const base: MobileTerminalSessionTab = {
      type: 'terminal',
      id: 'term-1::leaf-1',
      parentTabId: 'term-1',
      leafId: 'leaf-1',
      title: 'Claude',
      status: 'ready',
      terminal: 'pty-1',
      isActive: true,
      agentStatus: {
        state: 'working',
        prompt: '',
        updatedAt: 1,
        stateStartedAt: 1,
        paneKey: 'term-1:leaf-1',
        terminalHandle: 'pty-1',
        stateHistory: []
      }
    }

    expect(
      mobileSessionTabsEqual(
        [base],
        [
          {
            ...base,
            agentStatus: {
              ...base.agentStatus!,
              state: 'blocked',
              updatedAt: 2,
              stateStartedAt: 2
            }
          }
        ]
      )
    ).toBe(false)
  })
})
