import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalModelWait } from '../../server-model-wait'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const MINUTE = 60_000

describe("terminal Claude's model-time stopwatch", () => {
  let server: AgentHookServer
  let userDataPath: string
  let checks: (Pick<TerminalModelWait, 'toolMaybeOpen'> & { paneKey: string })[]

  const boot = async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    server.setTerminalPaneLifecycle({
      ownsProcess: () => true,
      isStopping: () => false,
      isReversibleStop: () => false,
      isPlaced: () => true,
      modelWaitElapsed: async (paneKey, wait) => {
        checks.push({ paneKey, toolMaybeOpen: wait.toolMaybeOpen })
        return true
      }
    })
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-model-wait-'))
    checks = []
    await boot()
  })

  afterEach(() => {
    server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
    vi.useRealTimers()
  })

  const hook = async (payload: Record<string, unknown>) => {
    const response = await postHookEvent(server, buildBody({ session_id: 'session-a', ...payload }))
    expect(response.status).toBe(204)
  }
  const prompt = () => hook({ hook_event_name: 'UserPromptSubmit', prompt: 'task' })
  const tool = (event: string, id: string) =>
    hook({ hook_event_name: event, tool_name: 'Bash', tool_use_id: id, tool_input: {} })

  it('asks for the screen after 10 quiet minutes of model time, and every 10 after', async () => {
    await prompt()
    await vi.advanceTimersByTimeAsync(9 * MINUTE)
    expect(checks).toEqual([])
    await vi.advanceTimersByTimeAsync(1 * MINUTE)
    expect(checks).toEqual([{ paneKey: PANE, toolMaybeOpen: false }])
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(checks).toHaveLength(2)
  })

  it('restarts the stopwatch on every hook', async () => {
    await prompt()
    await vi.advanceTimersByTimeAsync(6 * MINUTE)
    await tool('PreToolUse', 'tool-1')
    await tool('PostToolUse', 'tool-1')
    await vi.advanceTimersByTimeAsync(6 * MINUTE)
    expect(checks).toEqual([])
    await vi.advanceTimersByTimeAsync(4 * MINUTE)
    expect(checks).toEqual([{ paneKey: PANE, toolMaybeOpen: false }])
  })

  it('counts a running lead tool as tool time once Claude has shown it sends PostToolBatch', async () => {
    await prompt()
    await tool('PreToolUse', 'tool-1')
    await hook({ hook_event_name: 'PostToolBatch' })
    // A 25-minute command whose PostToolUse never comes; PostToolBatch would close it.
    await tool('PreToolUse', 'tool-2')
    await vi.advanceTimersByTimeAsync(25 * MINUTE)
    expect(checks).toEqual([])
  })

  it('lets the screen judge an open tool from a Claude that never sent PostToolBatch', async () => {
    await prompt()
    await tool('PreToolUse', 'tool-1')
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(checks).toEqual([{ paneKey: PANE, toolMaybeOpen: true }])
  })

  it("keeps a nested Claude, run by the lead's open tool, from ending the lead's tool time", async () => {
    await prompt()
    await tool('PreToolUse', 'tool-1')
    await hook({ hook_event_name: 'PostToolBatch' })
    await tool('PreToolUse', 'tool-2')
    // `claude -p` inside the lead's Bash shares the pane key, not the session.
    await hook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'nested',
      session_id: 'session-nested'
    })
    const nested = { tool_name: 'Read', tool_use_id: 'nested-1', tool_input: {} }
    await hook({ hook_event_name: 'PreToolUse', session_id: 'session-nested', ...nested })
    await hook({ hook_event_name: 'PostToolUse', session_id: 'session-nested', ...nested })
    await vi.advanceTimersByTimeAsync(25 * MINUTE)
    expect(checks).toEqual([])
  })

  it('keeps counting an open tool as tool time in the turns after the one that sent PostToolBatch', async () => {
    await prompt()
    await tool('PreToolUse', 'tool-1')
    await hook({ hook_event_name: 'PostToolBatch' })
    await hook({ hook_event_name: 'Stop' })
    await prompt()
    await tool('PreToolUse', 'tool-2')
    await vi.advanceTimersByTimeAsync(25 * MINUTE)
    expect(checks).toEqual([])
  })

  it('follows the pane to its new key when the pane is reminted mid-wait', async () => {
    const moved = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')
    await prompt()
    server.transferPaneAuthority(PANE, moved, 'pty-1')
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(checks).toEqual([{ paneKey: moved, toolMaybeOpen: false }])
  })

  it('follows the pane through a second move, made from the key the first one gave it', async () => {
    const first = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')
    const second = makePaneKey('tab-3', '33333333-3333-4333-8333-333333333333')
    server.transferPaneAuthority(PANE, first, 'pty-1')
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'task', paneKey: first })
    server.transferPaneAuthority(first, second, 'pty-1')
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(checks).toEqual([{ paneKey: second, toolMaybeOpen: false }])
  })

  it('starts the stopwatch for a turn still working when Orca restarts', async () => {
    await prompt()
    const before = server
    before.stop()
    // Only the restarted server's stopwatch may ask.
    before.setTerminalPaneLifecycle({
      ownsProcess: () => true,
      isStopping: () => false,
      isReversibleStop: () => false,
      isPlaced: () => true
    })
    await boot()
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    // A tool begun before the restart left no hook here, so the screen judges it.
    expect(checks).toEqual([{ paneKey: PANE, toolMaybeOpen: true }])
  })

  it('stops at the turn end', async () => {
    await prompt()
    await hook({ hook_event_name: 'Stop' })
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(checks).toEqual([])
  })
})
