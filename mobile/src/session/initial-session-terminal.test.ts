import { describe, expect, it } from 'vitest'
import {
  shouldAutoCreateInitialSessionTerminal,
  type InitialSessionTerminalAutoCreateInput
} from './initial-session-terminal'

function baseInput(
  overrides: Partial<InitialSessionTerminalAutoCreateInput> = {}
): InitialSessionTerminalAutoCreateInput {
  return {
    newlyCreatedWorkspace: true,
    connected: true,
    tabsLoaded: true,
    visibleTabCount: 0,
    hasActiveTerminalHandle: false,
    createInFlight: false,
    sawSessionTabs: false,
    autoCreatedForWorktree: false,
    ...overrides
  }
}

describe('shouldAutoCreateInitialSessionTerminal', () => {
  it('creates the first terminal for a workspace that hydrates with nothing', () => {
    expect(shouldAutoCreateInitialSessionTerminal(baseInput())).toBe(true)
  })

  it('does not re-create once this route has shown session tabs', () => {
    expect(shouldAutoCreateInitialSessionTerminal(baseInput({ sawSessionTabs: true }))).toBe(false)
  })

  it('does not create from stale empty state while switching ordinary workspace routes', () => {
    expect(
      shouldAutoCreateInitialSessionTerminal(
        baseInput({
          newlyCreatedWorkspace: false,
          tabsLoaded: true,
          visibleTabCount: 0
        })
      )
    ).toBe(false)
  })

  it('stays armed while an empty workspace is still loading', () => {
    expect(shouldAutoCreateInitialSessionTerminal(baseInput({ tabsLoaded: false }))).toBe(false)
  })

  it('waits for the host connection', () => {
    expect(shouldAutoCreateInitialSessionTerminal(baseInput({ connected: false }))).toBe(false)
  })

  it('defers to a lagging snapshot that still has a streaming terminal', () => {
    expect(
      shouldAutoCreateInitialSessionTerminal(baseInput({ hasActiveTerminalHandle: true }))
    ).toBe(false)
  })

  it('does not stack a second create on an in-flight one', () => {
    expect(shouldAutoCreateInitialSessionTerminal(baseInput({ createInFlight: true }))).toBe(false)
  })

  it('fires at most once per workspace on this route', () => {
    expect(
      shouldAutoCreateInitialSessionTerminal(baseInput({ autoCreatedForWorktree: true }))
    ).toBe(false)
  })

  it('does not fire while tabs are visible', () => {
    expect(shouldAutoCreateInitialSessionTerminal(baseInput({ visibleTabCount: 2 }))).toBe(false)
  })
})
