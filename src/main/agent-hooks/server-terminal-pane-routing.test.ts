import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import {
  buildBody,
  FRESH_PANE,
  OLD_PANE,
  PANE,
  postHookEvent,
  TAB_A_PANE
} from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

// A terminal that survived a restart: its environment still exports OLD_PANE, but it now shows in
// FRESH_PANE (a tab the adoption path minted with a new id).
const movedTerminal = (paneKey: string): string | undefined =>
  paneKey === OLD_PANE ? FRESH_PANE : undefined
const MOVE = {
  fromPaneKey: OLD_PANE,
  toPaneKey: FRESH_PANE,
  connectionId: null,
  ptyId: 'pty-moved'
}

function postFromSpawnedPane(server: AgentHookServer, prompt: string): Promise<Response> {
  return postHookEvent(
    server,
    buildBody(
      { hook_event_name: 'UserPromptSubmit', prompt },
      { paneKey: OLD_PANE, tabId: 'tab-old' }
    )
  )
}

describe('agent status follows the terminal, not the pane key it was spawned with', () => {
  let userDataPath: string
  let server: AgentHookServer

  beforeEach(async () => {
    _internals.resetCachesForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-terminal-pane-routing-'))
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
  })

  afterEach(() => {
    server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('files a hook posted under the spawn key on the pane that shows the terminal now', async () => {
    server.setTerminalPaneResolver(movedTerminal)

    expect((await postFromSpawnedPane(server, 'after the restart')).status).toBe(204)

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: FRESH_PANE,
        tabId: 'tab-fresh',
        state: 'working',
        prompt: 'after the restart'
      })
    ])
  })

  it('moves rows filed under the spawn key once the host can route them', async () => {
    await postFromSpawnedPane(server, 'before the host knew')
    expect(server.getStatusSnapshot().map((row) => row.paneKey)).toEqual([OLD_PANE])

    server.setTerminalPaneResolver(movedTerminal)
    server.reconcileMovedTerminalPaneKeys([MOVE])

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: FRESH_PANE,
        tabId: 'tab-fresh',
        prompt: 'before the host knew'
      })
    ])
    server.flushStatusPersistSync()
    expect(
      JSON.parse(readFileSync(join(userDataPath, 'agent-hooks', 'last-status.json'), 'utf8'))
    ).toEqual(expect.objectContaining({ entries: { [FRESH_PANE]: expect.anything() } }))
  })

  it('keeps the spawn-key row when it is newer than the live pane’s own row', async () => {
    await postHookEvent(
      server,
      buildBody(
        { hook_event_name: 'UserPromptSubmit', prompt: 'older pane row' },
        { paneKey: FRESH_PANE, tabId: 'tab-fresh' }
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    await postFromSpawnedPane(server, 'newer from the process')

    server.setTerminalPaneResolver(movedTerminal)
    server.reconcileMovedTerminalPaneKeys([MOVE])

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: FRESH_PANE, prompt: 'newer from the process' })
    ])
  })

  it('judges a replayed row by the age of its evidence, not its delivery', async () => {
    const post = (paneKey: string, prompt: string, isReplay = false): void =>
      server.ingestRemote(
        {
          paneKey,
          tabId: paneKey.split(':')[0],
          worktreeId: 'wt-1',
          source: 'claude',
          hookEventName: 'UserPromptSubmit',
          ...(isReplay ? { isReplay: true } : {}),
          payload: { state: 'working', prompt, agentType: 'claude' }
        },
        null
      )
    post(OLD_PANE, 'old evidence')
    await new Promise((resolve) => setTimeout(resolve, 5))
    post(FRESH_PANE, 'live')
    await new Promise((resolve) => setTimeout(resolve, 5))
    post(OLD_PANE, 'old evidence', true)

    server.reconcileMovedTerminalPaneKeys([MOVE])

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: FRESH_PANE, prompt: 'live' })
    ])
  })

  it('follows the alias its own pane move minted to the state filed there', async () => {
    await postFromSpawnedPane(server, 'before detach')
    server.transferPaneAuthority(OLD_PANE, PANE, 'pty-moved')
    expect(server.getStatusSnapshot().map((row) => row.paneKey)).toEqual([PANE])

    server.reconcileMovedTerminalPaneKeys([MOVE])

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: FRESH_PANE, prompt: 'before detach' })
    ])
  })

  it('leaves state under another process’s alias alone', async () => {
    await postFromSpawnedPane(server, 'other process')
    server.transferPaneAuthority(OLD_PANE, PANE, 'pty-other')

    server.reconcileMovedTerminalPaneKeys([MOVE])

    expect(server.getStatusSnapshot().map((row) => row.paneKey)).toEqual([PANE])
  })

  it('never replaces a row another host filed on the destination pane', async () => {
    await postFromSpawnedPane(server, 'local')
    server.ingestRemote(
      {
        paneKey: FRESH_PANE,
        tabId: 'tab-fresh',
        worktreeId: 'wt-1',
        source: 'claude',
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'remote', agentType: 'claude' }
      },
      'ssh-other'
    )
    await postFromSpawnedPane(server, 'local, newer')

    server.reconcileMovedTerminalPaneKeys([MOVE])

    expect(
      Object.fromEntries(server.getStatusSnapshot().map((row) => [row.paneKey, row.prompt]))
    ).toEqual({ [OLD_PANE]: 'local, newer', [FRESH_PANE]: 'remote' })
  })

  it('leaves aliases untouched when a move is rejected for another host’s row', async () => {
    await postFromSpawnedPane(server, 'local')
    // An alias that falls back onto the exported key.
    server.transferPaneAuthority(TAB_A_PANE, OLD_PANE, 'pty-detached')
    server.ingestRemote(
      {
        paneKey: FRESH_PANE,
        tabId: 'tab-fresh',
        worktreeId: 'wt-1',
        source: 'claude',
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'remote', agentType: 'claude' }
      },
      'ssh-other'
    )
    await postFromSpawnedPane(server, 'local, newer')

    server.reconcileMovedTerminalPaneKeys([MOVE])
    await postHookEvent(
      server,
      buildBody(
        { hook_event_name: 'UserPromptSubmit', prompt: 'via alias' },
        { paneKey: TAB_A_PANE, tabId: 'tab-A' }
      )
    )

    expect(
      Object.fromEntries(server.getStatusSnapshot().map((row) => [row.paneKey, row.prompt]))
    ).toEqual({ [OLD_PANE]: 'via alias', [FRESH_PANE]: 'remote' })
  })

  it('never moves a row posted by another host onto a terminal’s pane', async () => {
    server.ingestRemote(
      {
        paneKey: OLD_PANE,
        tabId: 'tab-old',
        worktreeId: 'wt-1',
        source: 'claude',
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'remote', agentType: 'claude' }
      },
      'ssh-other'
    )

    server.reconcileMovedTerminalPaneKeys([MOVE])

    expect(server.getStatusSnapshot().map((row) => row.paneKey)).toEqual([OLD_PANE])
  })

  it('drops the spawn-key row when the live pane already reports for itself', async () => {
    await postFromSpawnedPane(server, 'stale')
    await postHookEvent(
      server,
      buildBody(
        { hook_event_name: 'UserPromptSubmit', prompt: 'current' },
        { paneKey: FRESH_PANE, tabId: 'tab-fresh' }
      )
    )

    server.setTerminalPaneResolver(movedTerminal)
    server.reconcileMovedTerminalPaneKeys([MOVE])

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: FRESH_PANE, prompt: 'current' })
    ])
  })

  it('never lets cleanup of the dead layout key reach the pane the terminal moved to', async () => {
    server.setTerminalPaneResolver(movedTerminal)
    await postFromSpawnedPane(server, 'live')

    server.clearPaneState(OLD_PANE)
    server.retirePaneAuthority(OLD_PANE)

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: FRESH_PANE, prompt: 'live' })
    ])
    // The process keeps posting its spawn key; the retired layout key must not suppress it.
    await postHookEvent(
      server,
      buildBody({ hook_event_name: 'Stop' }, { paneKey: OLD_PANE, tabId: 'tab-old' })
    )
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: FRESH_PANE, state: 'done' })
    ])
  })

  it('keeps a hook where it lands when the host cannot route the key', async () => {
    server.setTerminalPaneResolver(() => undefined)

    await postFromSpawnedPane(server, 'unrouted')

    expect(server.getStatusSnapshot().map((row) => row.paneKey)).toEqual([OLD_PANE])
  })
})
