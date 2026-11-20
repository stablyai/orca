import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import {
  ANTIGRAVITY_PARENT_WAKE_GRACE_MS,
  HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS
} from '../../../program-status/hook-precedence'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-agy-background-command-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  vi.useRealTimers()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

const turn = { conversationId: 'parent', lastUserInput: 'start the job' }

async function agyHook(hookEventName: string, payload: Record<string, unknown>): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ ...turn, ...payload }, { hookEventName }),
    '/hook/antigravity'
  )
  expect(response.status).toBe(204)
}

function programDone(): void {
  // agy's OSC 7501 says done at every turn end, including one that waits on a background command.
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    fromProgramStatus: true,
    payload: { prompt: '', state: 'done', agentType: 'antigravity' }
  })
}

const state = () => server.getStatusSnapshot()[0]?.state

it('keeps a turn waiting on a background command working past the hook-silence fallback, then bounds it', async () => {
  const command = {
    stepIdx: 2,
    toolCall: { name: 'run_command', args: { CommandLine: 'sleep 600', IsDaemon: false } }
  }
  await agyHook('PreInvocation', {})
  await agyHook('PreToolUse', command)
  await agyHook('Stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL' })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  // agy reports this done once; only the hook-silence recheck can offer it again.
  programDone()

  vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
  expect(state()).toBe('working')

  vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS)
  expect(state()).toBe('done')
})

const subagentCall = { stepIdx: 2, toolCall: { name: 'invoke_subagent', args: { Prompt: 'ls' } } }
const child = { conversationId: 'child', lastUserInput: '' }

// Order captured from agy 1.5.12: the parent stops busy and no parent hook follows its subagent's idle Stop.
async function parentStopsWhileSubagentRuns(): Promise<void> {
  await agyHook('PreInvocation', {})
  await agyHook('PreToolUse', subagentCall)
  await agyHook('PostToolUse', subagentCall)
  await agyHook('PreInvocation', child)
  await agyHook('PostInvocation', {})
  await agyHook('Stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL' })
  await agyHook('PostInvocation', child)
}

const subagentIdleStop = () =>
  agyHook('Stop', { ...child, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' })

it.each([
  ['after', false],
  ['before', true]
])(
  'ends the run on agy done that arrives %s its last subagent stops after the parent turn',
  async (_order, doneFirst) => {
    await parentStopsWhileSubagentRuns()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    if (doneFirst) {
      programDone()
    }
    await subagentIdleStop()
    if (!doneFirst) {
      programDone()
    }
    expect(state()).toBe('working')

    vi.advanceTimersByTime(ANTIGRAVITY_PARENT_WAKE_GRACE_MS + 1)
    expect(state()).toBe('done')
  }
)

it("waits out the grace after a parent's busy Stop that lands after its subagent's", async () => {
  await agyHook('PreInvocation', {})
  await agyHook('PreToolUse', subagentCall)
  await agyHook('PostToolUse', subagentCall)
  await agyHook('PreInvocation', child)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  await subagentIdleStop()
  vi.advanceTimersByTime(ANTIGRAVITY_PARENT_WAKE_GRACE_MS + 1000)
  await agyHook('Stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL' })
  programDone()
  expect(state()).toBe('working')

  vi.advanceTimersByTime(ANTIGRAVITY_PARENT_WAKE_GRACE_MS + 1)
  expect(state()).toBe('done')
})

it("keeps the run working when agy's done lands while a sibling subagent still works", async () => {
  await parentStopsWhileSubagentRuns()
  await agyHook('PreInvocation', { conversationId: 'sibling', lastUserInput: '' })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  programDone()
  await subagentIdleStop()

  await vi.advanceTimersByTimeAsync(ANTIGRAVITY_PARENT_WAKE_GRACE_MS * 2)
  expect(state()).toBe('working')
  await agyHook('Stop', { ...child, conversationId: 'sibling', fullyIdle: true })
  await vi.advanceTimersByTimeAsync(1000)
  expect(state()).toBe('working')
  await vi.advanceTimersByTimeAsync(1001)
  expect(state()).toBe('done')
})

it('discards an earlier refused done when a new root prompt opens', async () => {
  await parentStopsWhileSubagentRuns()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  programDone()
  await vi.advanceTimersByTimeAsync(4001)
  await agyHook('PreInvocation', { lastUserInput: 'a new task' })
  await subagentIdleStop()
  await vi.advanceTimersByTimeAsync(4001)
  expect(state()).toBe('working')
})

it('discards a refused done when the program reports new work', async () => {
  await parentStopsWhileSubagentRuns()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  programDone()
  await vi.advanceTimersByTimeAsync(4001)
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    fromProgramStatus: true,
    payload: { prompt: '', state: 'working', agentType: 'antigravity' }
  })
  await subagentIdleStop()
  await vi.advanceTimersByTimeAsync(4001)
  expect(state()).toBe('working')
})

it('reoffers one relayed done after the final verified child disappears', async () => {
  const connectionId = 'ssh-agy'
  const leadStartedAt = Date.now()
  server.beginRemoteRelaySession(connectionId)
  const report = (ids: string[], hookEventName?: string): void => {
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'antigravity',
        providerSession: { key: 'conversation_id', id: 'remote-root' },
        agentPresence: { agent: 'antigravity', session: 'remote-root' },
        hookEventName,
        payload: {
          prompt: 'remote job',
          state: 'working',
          agentType: 'antigravity',
          mainAgent: { state: 'done', stateStartedAt: leadStartedAt },
          subagents: ids.map((id) => ({ id, state: 'working', startedAt: 1, description: id }))
        }
      },
      connectionId
    )
  }
  report(['a', 'b'], 'Stop')
  expect(server.getStatusSnapshot()[0]?.subagents).toHaveLength(2)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId,
    fromProgramStatus: true,
    payload: { prompt: '', state: 'done', agentType: 'antigravity' }
  })
  await vi.advanceTimersByTimeAsync(4001)
  report(['b'])
  await vi.advanceTimersByTimeAsync(4001)
  expect(state()).toBe('working')
  report([])
  await vi.advanceTimersByTimeAsync(1000)
  report([])
  expect(state()).toBe('working')
  await vi.advanceTimersByTimeAsync(1001)
  expect(state()).toBe('done')
})
