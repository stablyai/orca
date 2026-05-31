import { describe, expect, it } from 'vitest'
import {
  getTerminalRecordsFromSessionTabs,
  mergeTerminalListWithKnownRecords,
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
})
