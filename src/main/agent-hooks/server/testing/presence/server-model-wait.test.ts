import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, postHookEvent } from '../server.test-fixtures'
import type { TerminalModelWait } from '../../server-model-wait'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const MINUTE = 60_000

describe("terminal Claude's model-time stopwatch", () => {
  let server: AgentHookServer
  let userDataPath: string
  let checks: Pick<TerminalModelWait, 'toolMaybeOpen'>[]

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-model-wait-'))
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    checks = []
    server.setTerminalPaneLifecycle({
      ownsProcess: () => true,
      isStopping: () => false,
      isReversibleStop: () => false,
      isPlaced: () => true,
      modelWaitElapsed: async (_paneKey, wait) => {
        checks.push({ toolMaybeOpen: wait.toolMaybeOpen })
        return true
      }
    })
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
    expect(checks).toEqual([{ toolMaybeOpen: false }])
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
    expect(checks).toEqual([{ toolMaybeOpen: false }])
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
    expect(checks).toEqual([{ toolMaybeOpen: true }])
  })

  it('stops at the turn end', async () => {
    await prompt()
    await hook({ hook_event_name: 'Stop' })
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(checks).toEqual([])
  })
})
