import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const deps: { current: object | null } = { current: null }
  return {
    handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
    deps,
    setAgentKept: vi.fn((_deps: unknown, _request: unknown) => ({ ok: true }))
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      state.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../agent-accounts/agent-account-keep-wiring', () => ({
  installedAgentKeepDeps: () => state.deps.current
}))
vi.mock('../agent-accounts/agent-account-keep', () => ({ setAgentKept: state.setAgentKept }))

import { readSetAgentKeptRequest, registerAgentAccountKeepHandlers } from './agent-account-keep'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function setKept(args: unknown): unknown {
  return state.handlers.get('agentAccounts:setKept')!({}, args)
}

beforeEach(() => {
  state.handlers.clear()
  state.deps.current = { installed: true }
  state.setAgentKept.mockClear()
  registerAgentAccountKeepHandlers()
})

describe('agentAccounts:setKept', () => {
  it('passes a well-formed request to the host keep', () => {
    expect(setKept({ paneKey: PANE, ptyId: 'pty-1', kept: true })).toEqual({ ok: true })
    expect(state.setAgentKept).toHaveBeenCalledWith(state.deps.current, {
      paneKey: PANE,
      ptyId: 'pty-1',
      kept: true
    })
  })

  it('refuses where no producer runs', () => {
    state.deps.current = null
    expect(setKept({ paneKey: PANE, kept: false })).toEqual({ ok: false, reason: 'unknown-pane' })
    expect(state.setAgentKept).not.toHaveBeenCalled()
  })
})

describe('readSetAgentKeptRequest', () => {
  it.each([
    ['no object', null],
    ['a malformed pane key', { paneKey: 'pane', kept: true }],
    ['an oversized pty id', { paneKey: PANE, ptyId: 'x'.repeat(513), kept: true }],
    ['a non-string pty id', { paneKey: PANE, ptyId: 7, kept: true }],
    ['a missing kept flag', { paneKey: PANE }]
  ])('rejects %s', (_label, value) => {
    expect(readSetAgentKeptRequest(value)).toBeNull()
  })
})
