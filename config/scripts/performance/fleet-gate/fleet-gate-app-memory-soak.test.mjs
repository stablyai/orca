import { describe, expect, it } from 'vitest'
import { CensusUnsure, LinuxOrcaCensus, showChat } from './fleet-gate-app-memory-soak.mjs'

const ELECTRON = '/opt/orca/electron'
const PROVIDER_EXEC = '/opt/orca/native/provider-exec/.build/orca-provider-exec'
const AGENT = '/usr/bin/node'

// main 10 -> daemon 20 (Electron) -> supervisor 30 -> agent 40 -> watcher 50 (forked under the agent).
function fakeProc() {
  const table = new Map([
    [10, { ppid: 1, exe: ELECTRON }],
    [20, { ppid: 10, exe: ELECTRON }],
    [30, { ppid: 20, exe: PROVIDER_EXEC }],
    [40, { ppid: 30, exe: AGENT }],
    [50, { ppid: 40, exe: PROVIDER_EXEC }],
    [60, { ppid: 1, exe: '/usr/bin/unrelated' }]
  ])
  const faults = new Map()
  const read = (pid, field) => {
    const fault = faults.get(`${String(pid)}:${field}`)
    if (fault) {
      throw Object.assign(new Error(`${fault} ${String(pid)}`), { code: fault })
    }
    return table.get(pid)
  }
  return {
    table,
    faults,
    pids: () => [...table.keys()],
    stat: (pid) => {
      const row = read(pid, 'stat')
      return row ? { state: 'S', ppid: row.ppid, start: `start-${String(pid)}` } : null
    },
    exe: (pid) => read(pid, 'exe')?.exe ?? null
  }
}

const discovered = (census) =>
  census
    .discover(10, [20], new Set([10]))
    .map(({ pid }) => pid)
    .sort()

describe('LinuxOrcaCensus', () => {
  it('counts the provider watcher forked under the agent, and no agent or unrelated process', () => {
    expect(discovered(new LinuxOrcaCensus(fakeProc()))).toEqual([20, 30, 50])
  })

  it('is unsure, not quietly smaller, when a counted process becomes unreadable while still running', () => {
    const proc = fakeProc()
    const census = new LinuxOrcaCensus(proc)
    discovered(census)
    proc.faults.set('30:exe', 'EACCES')
    expect(() => discovered(census)).toThrow()
    proc.faults.clear()
    proc.faults.set('30:stat', 'EACCES')
    expect(() => discovered(census)).toThrow()
  })

  it('is unsure when a live descendant is unreadable at the first census, before anything is known', () => {
    const proc = fakeProc()
    proc.faults.set('30:exe', 'EACCES')
    expect(() => discovered(new LinuxOrcaCensus(proc))).toThrow()
  })

  it('is unsure when a counted process is still running but no longer reached', () => {
    const proc = fakeProc()
    const census = new LinuxOrcaCensus(proc)
    discovered(census)
    // Its parent's stat failed to read, so the walk can't reach it, but it is still alive.
    proc.table.set(30, { ppid: 999, exe: PROVIDER_EXEC })
    expect(() => discovered(census)).toThrow(CensusUnsure)
  })

  it('forgets a counted process that exited', () => {
    const proc = fakeProc()
    const census = new LinuxOrcaCensus(proc)
    discovered(census)
    proc.table.delete(50)
    expect(discovered(census)).toEqual([20, 30])
  })
})

/** A page whose store reports the chat selected; the DOM holds whatever the test mounts. */
function fakePage(elements) {
  const store = {
    activeView: 'terminal',
    activeWorktreeId: 'wt',
    unifiedTabsByWorktree: { wt: [{ id: 'tab', contentType: 'agent-session', entityId: 's1' }] },
    setActiveView() {},
    setActiveWorktree() {},
    activateTab() {},
    getActiveTab: () => ({ id: 'tab' })
  }
  return {
    evaluate: async (fn, arg) => {
      globalThis.window = { __store: { getState: () => store } }
      globalThis.document = { querySelectorAll: () => elements }
      try {
        return await fn(arg)
      } finally {
        delete globalThis.window
        delete globalThis.document
      }
    }
  }
}

const composer = (scope, laidOut) => ({
  getAttribute: () => scope,
  getClientRects: () => (laidOut ? [{}] : [])
})

describe('showChat', () => {
  const chat = { sessionId: 's1', worktreeId: 'wt' }

  it('is not a show when the store says selected but the workbench crashed and no chat pane is mounted', async () => {
    expect(await showChat(fakePage([]), chat, 0)).toBe(false)
  })

  it('is not a show when only a hidden copy of the pane is mounted', async () => {
    expect(await showChat(fakePage([composer('structured:s1', false)]), chat, 0)).toBe(false)
  })

  it("is a show once that chat's composer is laid out", async () => {
    expect(await showChat(fakePage([composer('structured:s1', true)]), chat, 0)).toBe(true)
  })
})
