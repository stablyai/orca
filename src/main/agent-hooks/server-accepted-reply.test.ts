import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'
import { mainAgentDoneAt } from '../../shared/agent-status/lifecycle/main-agent-status'
import type { AutomationRun } from '../../shared/automations-types'
import { createRuntimeAutomationRunTerminalObserver } from '../automations/runtime-terminal-run-observer'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

const CHILD = 'a6324370b7bede0c7'
// Markers past the 8,000-char status preview prove the whole reply survived.
const REPLY = `START ${'a'.repeat(12_000)} MIDDLE-MARKER ${'b'.repeat(12_000)} END-MARKER`

let userDataPath: string
let server: AgentHookServer

beforeEach(async () => {
  _internals.resetCachesForTests()
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-accepted-reply-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath })
})

afterEach(() => {
  server.stop()
  rmSync(userDataPath, { recursive: true, force: true })
})

async function post(payload: Record<string, unknown>): Promise<void> {
  const env = server.buildPtyEnv()
  await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify(buildBody(payload))
  })
}

/** What a run watcher reads: the reply for the lead turn its selected row reports finished. */
function replyForCurrentRow(): string | undefined {
  const row = server.getStatusSnapshotForPane(PANE)[0]
  const leadTurnKey = row ? mainAgentDoneAt(row) : undefined
  return leadTurnKey === undefined ? undefined : server.getAcceptedReply(PANE, leadTurnKey)
}

describe('accepted lead reply', () => {
  it('keeps the whole reply for its turn, out of saved and public status, until a new prompt', async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'write the report' })
    await post({ hook_event_name: 'Stop', last_assistant_message: REPLY })

    expect(replyForCurrentRow()).toBe(REPLY)
    server.flushStatusPersistSync()
    for (const published of [
      readFileSync(join(userDataPath, 'agent-hooks', 'last-status.json'), 'utf8'),
      JSON.stringify(server.getStatusSnapshot())
    ]) {
      expect(published).not.toContain('MIDDLE-MARKER')
      expect(published).not.toContain('acceptedReply')
      expect(published).not.toContain('replyCandidate')
    }

    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'next task' })
    await post({ hook_event_name: 'Stop' })
    expect(replyForCurrentRow()).toBeUndefined()
  })

  it.each([
    { name: 'a running child', permission: false },
    { name: "a child's visible permission prompt", permission: true }
  ])('keeps a reply the lead gave while $name held the turn', async ({ permission }) => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'research in background' })
    await post({ hook_event_name: 'SubagentStart', agent_id: CHILD, agent_type: 'general-purpose' })
    if (permission) {
      await post({
        hook_event_name: 'PermissionRequest',
        agent_id: CHILD,
        agent_type: 'general-purpose',
        tool_name: 'Bash',
        tool_input: { command: 'make' }
      })
    }
    await post({
      hook_event_name: 'Stop',
      last_assistant_message: REPLY,
      background_tasks: [{ id: CHILD, type: 'subagent', status: 'running' }]
    })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: permission ? 'waiting' : 'working',
      mainAgent: { state: 'done' }
    })

    await post({ hook_event_name: 'SubagentStop', agent_id: CHILD, agent_type: 'general-purpose' })

    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
    expect(replyForCurrentRow()).toBe(REPLY)
  })

  it("saves the reply of an agent that exits right after it, though exit cleanup clears the pane's status", async () => {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'write the report' })
    const paneKey: string = PANE
    const observer = createRuntimeAutomationRunTerminalObserver(
      {
        getTerminalHandleForPaneKey: () => 'terminal-1',
        readTerminal: async () => ({ tail: [] }),
        canOpenRunTerminals: () => true,
        waitForTerminal: async () => {
          await post({ hook_event_name: 'Stop', last_assistant_message: REPLY })
          server.reconcileEndedProcessForPaneKeys([PANE])
          throw Object.assign(new Error('terminal_exited'), {
            terminalExitCause: { kind: 'exited', exitCode: 0 }
          })
        }
      },
      {
        getAgentStatusRowsForPane: (paneKey) => server.getStatusSnapshotForPane(paneKey),
        getAcceptedReply: (paneKey, leadTurnKey) => server.getAcceptedReply(paneKey, leadTurnKey),
        subscribeStatusChanges: (listener) =>
          server.subscribeStatusRowMutations(({ after }) => after && listener(after.paneKey)),
        agentCommandsForRun: () => ['claude']
      }
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the observer reads only these run fields.
    const run = { terminalPaneKey: paneKey, startedAt: 0, dispatchedAt: 0 } as AutomationRun

    const observation = await observer.observeCompletion('terminal-1', {
      signal: new AbortController().signal,
      run
    })

    expect(replyForCurrentRow()).toBeUndefined()
    expect(observation).toMatchObject({
      status: 'completed',
      outputSnapshot: { content: REPLY, truncated: false }
    })
  })
})
