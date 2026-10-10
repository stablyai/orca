import { describe, expect, it } from 'vitest'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import {
  dispatchVoiceMessageToAgent,
  type VoiceAgentDispatchDeps
} from './voice-control-agent-dispatch'
import type { VoiceRosterEntry } from './voice-control-roster'
import { VOICE_CONTROL_HANDLE } from './voice-control-participant'

function entry(overrides: Partial<VoiceRosterEntry> = {}): VoiceRosterEntry {
  return {
    spokenName: 'oak',
    worktreeId: 'w1',
    repoId: 'r1',
    paneKey: 'tab-1:123e4567-e89b-12d3-a456-426614174000',
    agentType: 'claude',
    state: 'working',
    taskTitle: null,
    toolName: null,
    worktreePath: '/tmp/x',
    hostId: null,
    ...overrides
  }
}

function createDeps(overrides: Partial<VoiceAgentDispatchDeps> = {}) {
  const sent: { handle: string; body: string }[] = []
  const dbWrites: string[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch calls only these two methods and reads only .id off each row; the rest of the DB surface is fixture weight.
  const db = {
    createTask: () => {
      dbWrites.push('task')
      return { id: 'task-1' }
    },
    createDispatchContext: () => {
      dbWrites.push('ctx')
      return { id: 'dispatch-1' }
    }
  } as unknown as OrchestrationDb
  const deps: VoiceAgentDispatchDeps = {
    db,
    runtime: {
      sendTerminalAgentPrompt: (handle: string, prompt: string) => {
        sent.push({ handle, body: prompt })
        return Promise.resolve({})
      },
      getNestedWorkerMaxDepth: () => 2,
      isTerminalRunningAgent: () => Promise.resolve(true)
    },
    runId: 'run-1',
    terminalHandleForPaneKey: () => 'term_abc',
    ...overrides
  }
  return { deps, sent, dbWrites }
}

describe('dispatchVoiceMessageToAgent', () => {
  it('creates task + dispatch and sends a coordinator preamble naming the control', async () => {
    const { deps, sent } = createDeps()
    const result = await dispatchVoiceMessageToAgent(deps, entry(), 'run the tests')
    expect(result).toEqual({ kind: 'dispatched', dispatchId: 'dispatch-1' })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.handle).toBe('term_abc')
    expect(sent[0]?.body).toContain('run the tests')
    expect(sent[0]?.body).toContain(VOICE_CONTROL_HANDLE)
    expect(sent[0]?.body).toContain('dispatch-1')
  })

  it('is unreachable when the pane has no live terminal', async () => {
    const { deps, sent } = createDeps({ terminalHandleForPaneKey: () => null })
    const result = await dispatchVoiceMessageToAgent(deps, entry(), 'run the tests')
    expect(result.kind).toBe('unreachable')
    expect(sent).toHaveLength(0)
  })

  // Live failure this guards: the roster said main 2 was 'done' (stale from the prior
  // session) while its terminal was a bare shell; the ceremony wrote task + ctx, typed
  // the preamble into the void, and left a zombie dispatch that wedged the terminal for
  // an hour. The CLI's dispatch --inject refuses this with inject_rejected first.
  it('a bare shell behind the pane refuses BEFORE any task or dispatch row is written', async () => {
    const { deps, sent, dbWrites } = createDeps()
    deps.runtime.isTerminalRunningAgent = () => Promise.resolve(false)
    const result = await dispatchVoiceMessageToAgent(deps, entry(), 'run the tests')
    expect(result.kind).toBe('no-agent-detected')
    expect(sent).toHaveLength(0)
    expect(dbWrites).toEqual([])
  })

  it('a stalled turn start still counts as dispatched (preamble already in the pane)', async () => {
    const { deps } = createDeps()
    deps.runtime.sendTerminalAgentPrompt = () => Promise.reject(new Error('agent_prompt_stalled'))
    const result = await dispatchVoiceMessageToAgent(deps, entry(), 'run the tests')
    expect(result).toEqual({ kind: 'dispatched-unobserved', dispatchId: 'dispatch-1' })
  })

  it('propagates a genuine send failure', async () => {
    const { deps } = createDeps()
    deps.runtime.sendTerminalAgentPrompt = () => Promise.reject(new Error('pty gone'))
    await expect(dispatchVoiceMessageToAgent(deps, entry(), 'run the tests')).rejects.toThrow(
      'pty gone'
    )
  })
})
