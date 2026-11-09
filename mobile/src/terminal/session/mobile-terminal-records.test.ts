import { describe, expect, it } from 'vitest'
import {
  getTerminalRecordsFromSessionTabs,
  mergeTerminalListWithKnownRecords,
  mergeTerminalRecordsByCurrentOrder,
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
  it('keeps the known theme when a session-tab snapshot omits it', () => {
    const known: TerminalRecord[] = [
      { handle: 'pty-1', title: 'Old title', terminalTheme: darkTheme, isActive: false }
    ]
    const snapshot: TerminalRecord[] = [{ handle: 'pty-1', title: 'Current title', isActive: true }]

    expect(mergeTerminalRecordsByCurrentOrder(snapshot, known)).toEqual([
      { handle: 'pty-1', title: 'Current title', terminalTheme: darkTheme, isActive: true }
    ])
  })

  it('keeps the host pane identity when a session-tab snapshot omits it', () => {
    const known: TerminalRecord[] = [
      { handle: 'pty-1', title: 'Old title', isActive: false, agentIdentity: 'cursor' }
    ]
    const snapshot: TerminalRecord[] = [{ handle: 'pty-1', title: 'Current title', isActive: true }]

    expect(mergeTerminalRecordsByCurrentOrder(snapshot, known)).toEqual([
      { handle: 'pty-1', title: 'Current title', isActive: true, agentIdentity: 'cursor' }
    ])
  })

  it('lets an authoritative inventory replace or clear an earlier host identity', () => {
    const known: TerminalRecord[] = [
      { handle: 'pty-1', title: 'Terminal', isActive: true, agentIdentity: 'cursor' }
    ]
    for (const agentIdentity of ['claude', undefined]) {
      const listed: TerminalRecord[] = [
        { handle: 'pty-1', title: 'Terminal', isActive: true, agentIdentity }
      ]
      expect(mergeTerminalListWithKnownRecords(listed, known, [])[0]?.agentIdentity).toBe(
        agentIdentity
      )
    }
  })

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

  const record = (over: Partial<TerminalRecord> & { handle: string }): TerminalRecord => ({
    title: 'Terminal',
    terminalTheme: undefined,
    isActive: false,
    ...over
  })
  const terminalTab = (handle: string): MobileTerminalSessionTab => ({
    id: `tab-${handle}`,
    type: 'terminal',
    terminal: handle,
    title: 'Terminal',
    isActive: false
  })

  it('keeps the merge additive so absence only schedules the sweep', () => {
    const held = [
      record({ handle: 'pty-1', connected: true }),
      record({ handle: 'pty-2', connected: true })
    ]
    const tabs = [terminalTab('pty-1')]

    expect(
      mergeTerminalRecordsByCurrentOrder(getTerminalRecordsFromSessionTabs(tabs), held).map(
        (terminal) => terminal.handle
      )
    ).toEqual(['pty-1', 'pty-2'])
  })
})
