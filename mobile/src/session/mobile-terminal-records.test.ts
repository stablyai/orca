import { describe, expect, it, vi } from 'vitest'
import {
  getTerminalRecordsFromSessionTabs,
  mergeTerminalListWithKnownRecords,
  mergeTerminalRecordsByCurrentOrder,
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
  it('keeps the known theme when a session-tab snapshot omits it', () => {
    const known: TerminalRecord[] = [
      { handle: 'pty-1', title: 'Old title', terminalTheme: darkTheme, isActive: false }
    ]
    const snapshot: TerminalRecord[] = [{ handle: 'pty-1', title: 'Current title', isActive: true }]

    expect(mergeTerminalRecordsByCurrentOrder(snapshot, known)).toEqual([
      { handle: 'pty-1', title: 'Current title', terminalTheme: darkTheme, isActive: true }
    ])
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

  it('compares large unchanged snapshots without serializing status or theme data', () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      state: index % 2 === 0 ? ('working' as const) : ('waiting' as const),
      prompt: `prompt-${index}`,
      startedAt: index
    }))
    const tabs: MobileTerminalSessionTab[] = Array.from({ length: 40 }, (_, index) => ({
      type: 'terminal',
      id: `term-${index}::leaf-${index}`,
      parentTabId: `term-${index}`,
      leafId: `leaf-${index}`,
      title: 'Claude',
      status: 'ready',
      terminal: `pty-${index}`,
      terminalTheme: index % 2 === 0 ? lightTheme : darkTheme,
      isActive: index === 0,
      agentStatus: {
        state: 'working',
        prompt: 'ship it',
        updatedAt: 1,
        stateStartedAt: 1,
        agentType: 'claude',
        paneKey: `term-${index}:leaf-${index}`,
        terminalHandle: `pty-${index}`,
        stateHistory: history,
        interactivePrompt: 'q'.repeat(16_000),
        lastAssistantMessage: 'a'.repeat(8_000)
      }
    }))
    const copy = JSON.parse(JSON.stringify(tabs)) as MobileTerminalSessionTab[]
    const originalStringify = JSON.stringify
    let serializedCalls = 0
    let serializedChars = 0
    const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementation((...args) => {
      serializedCalls += 1
      const result = originalStringify(...args)
      serializedChars += result?.length ?? 0
      return result
    })

    const equal = mobileSessionTabsEqual(tabs, copy)
    stringifySpy.mockRestore()

    expect(equal).toBe(true)
    expect(serializedCalls).toBe(0)
    expect(serializedChars).toBe(0)
  })
})
