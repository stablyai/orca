import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

// cmd.exe, or a shell without prompt marks: the shell's return is the only word of the agent's end.
describe('an agent with no process to probe, in a shell without command marks', () => {
  let server: AgentHookServer
  let userDataPath: string
  let exits: string[]
  let shellAlone: boolean | null

  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-unmarked-exit-'))
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    exits = []
    server.setTerminalPaneLifecycle({
      ownsProcess: () => true,
      isStopping: () => false,
      isReversibleStop: () => false,
      isPlaced: () => true,
      confirmProcessExit: async () => shellAlone,
      agentExited: (paneKey) => exits.push(paneKey)
    })
    await postHookEvent(
      server,
      buildBody({ hook_event_name: 'UserPromptSubmit', session_id: 'session-b', prompt: 'task' })
    )
  })

  afterEach(() => {
    server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it("reports the agent exited once the host proves the pane's shell alone", async () => {
    shellAlone = true
    await server.reconcilePaneProcessExit(PANE)
    expect(exits).toEqual([PANE])
  })

  it('reports nothing where the host cannot tell, though the row still clears', async () => {
    shellAlone = null
    await server.reconcilePaneProcessExit(PANE)
    expect(exits).toEqual([])
    expect(server.getStatusSnapshotForPane(PANE).filter((row) => !row.providerSessionOnly)).toEqual(
      []
    )
  })
})
