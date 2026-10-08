import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-process-lifetime-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

function processLifetime(state: 'working' | 'done', yieldsToHookSince: number): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    origin: 'process',
    yieldsToHookSince,
    payload: { state, prompt: '', agentType: 'opencode' }
  })
}

async function openCodeHook(hookEventName: string): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ hook_event_name: hookEventName, sessionID: 'ses_1' }),
    '/hook/opencode'
  )
  expect(response.status).toBe(204)
}

function paneState(): string {
  return server.getStatusSnapshotForPane(PANE)[0]?.state ?? 'missing'
}

async function nextMillisecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

// One `opencode run` command in one pane: the host reports it from the process lifetime unless a
// hook producer (OpenCode 1's in-process plugin) reports the same pane during that command.
describe('process-lifetime status', () => {
  it('reports Working, then Done, when no hook speaks for the command', () => {
    const commandStartedAt = Date.now()
    processLifetime('working', commandStartedAt)
    expect(paneState()).toBe('working')
    processLifetime('done', commandStartedAt)
    expect(paneState()).toBe('done')
  })

  it('yields the rest of the command once a hook reports the pane', async () => {
    const commandStartedAt = Date.now()
    processLifetime('working', commandStartedAt)
    await openCodeHook('SessionBusy')
    // The hook is still Working, so the process exit must not write a second Done over it.
    processLifetime('done', commandStartedAt)
    expect(paneState()).toBe('working')
    await openCodeHook('SessionIdle')
    expect(paneState()).toBe('done')
  })

  it('writes no Working over a hook that already claimed the command', async () => {
    const commandStartedAt = Date.now()
    await openCodeHook('SessionIdle')
    processLifetime('working', commandStartedAt)
    expect(paneState()).toBe('done')
  })

  it('does not yield to a hook row from before the command started', async () => {
    await openCodeHook('SessionIdle')
    await nextMillisecond()
    const commandStartedAt = Date.now()
    processLifetime('working', commandStartedAt)
    expect(paneState()).toBe('working')
    processLifetime('done', commandStartedAt)
    expect(paneState()).toBe('done')
  })

  // Why: a pane where an Orca-launched agent exited is retired; a new `opencode run` there is a new run.
  it('revives a retired pane on its Working, as a hook new-turn event does', () => {
    server.retirePaneAuthority(PANE)
    const commandStartedAt = Date.now()
    processLifetime('working', commandStartedAt)
    expect(paneState()).toBe('working')
    processLifetime('done', commandStartedAt)
    expect(paneState()).toBe('done')
  })

  it('keeps OSC status and a lone process Done out of a retired pane', () => {
    server.retirePaneAuthority(PANE)
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      payload: { state: 'working', prompt: '', agentType: 'opencode' }
    })
    processLifetime('done', Date.now())
    expect(paneState()).toBe('missing')
  })
})
