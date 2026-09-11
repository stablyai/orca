import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInterruptInputIntent } from '../../shared/agent-interrupt-intent'
import type { EnrichedAgentHookEventPayload } from './server/server-types'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

type HookRow = {
  source: string
  hookEventName: string
  state: 'working' | 'waiting' | 'done'
  prompt: string
  agentType: string
  toolName?: string
  interrupted?: boolean
  subagents?: { id: string; state: string; startedAt: number }[]
}

function ingest(server: AgentHookServer, row: HookRow): void {
  const { source, hookEventName, ...payload } = row
  server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      source,
      hookEventName,
      payload
    },
    'conn-1'
  )
}

/** The request `createAgentInterruptInference` emits for this row after its settle window.
 *  Its shape is pinned on the renderer side by agent-interrupt-inference.test.ts; the renderer
 *  cannot be imported here because tsconfig.node.json maps neither `@/` nor renderer sources. */
function pressInterruptKey(
  server: AgentHookServer,
  intent: AgentInterruptInputIntent,
  presses = 1
): boolean {
  const row = server.getStatusSnapshotForPane(PANE)[0]
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: row.receivedAt,
    baselineStateStartedAt: row.stateStartedAt,
    baselinePrompt: row.prompt,
    baselineAgentType: row.agentType,
    intent,
    ...(presses > 1 ? { inputCount: presses } : {})
  })
}

function collectPublishedStates(server: AgentHookServer): EnrichedAgentHookEventPayload[] {
  const published: EnrichedAgentHookEventPayload[] = []
  server.subscribeEnrichedStatus((payload) => published.push(payload))
  return published
}

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('navigation Escape during an open tool call', () => {
  it('leaves Claude working when Escape dismisses the /btw composer mid-tool (#13547)', () => {
    const server = new AgentHookServer()
    ingest(server, {
      source: 'claude',
      hookEventName: 'PreToolUse',
      state: 'working',
      prompt: 'migrate the schema',
      agentType: 'claude',
      toolName: 'Bash'
    })
    const published = collectPublishedStates(server)

    vi.setSystemTime(1_200)
    expect(pressInterruptKey(server, 'plain-escape')).toBe(false)

    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      toolName: 'Bash'
    })
    expect(published).toEqual([])
  })

  it('leaves OMP top-level work running when Escape closes a focused child or settings view (#9208)', () => {
    const server = new AgentHookServer()
    ingest(server, {
      source: 'omp',
      hookEventName: 'tool_execution_start',
      state: 'working',
      prompt: 'refactor the parser',
      agentType: 'omp',
      toolName: 'shell'
    })
    const published = collectPublishedStates(server)

    vi.setSystemTime(1_200)
    expect(pressInterruptKey(server, 'plain-escape')).toBe(false)
    // Why: OMP's second Escape is more navigation, so even a double-press request must not infer.
    vi.setSystemTime(1_400)
    expect(pressInterruptKey(server, 'plain-escape', 2)).toBe(false)

    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working'
    })
    expect(published).toEqual([])
  })

  it('still settles an OMP main-view abort from the provider lifecycle', () => {
    const server = new AgentHookServer()
    ingest(server, {
      source: 'omp',
      hookEventName: 'tool_execution_start',
      state: 'working',
      prompt: 'refactor the parser',
      agentType: 'omp'
    })
    vi.setSystemTime(1_200)
    expect(pressInterruptKey(server, 'plain-escape')).toBe(false)

    vi.setSystemTime(1_500)
    ingest(server, {
      source: 'omp',
      hookEventName: 'agent_end',
      state: 'done',
      prompt: 'refactor the parser',
      agentType: 'omp'
    })

    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'done'
    })
  })

  it.each([
    ['pi', 'tool_call'],
    ['prime-agent', 'tool_execution_start']
  ])('leaves %s work running when Escape closes an overlay mid-%s', (agentType, hookEventName) => {
    const server = new AgentHookServer()
    ingest(server, {
      source: agentType,
      hookEventName,
      state: 'working',
      prompt: 'refactor the parser',
      agentType,
      toolName: 'shell'
    })

    vi.setSystemTime(1_200)
    expect(pressInterruptKey(server, 'plain-escape')).toBe(false)
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({ state: 'working' })
  })

  it('still infers a Claude Escape once the tool call has closed', () => {
    const server = new AgentHookServer()
    ingest(server, {
      source: 'claude',
      hookEventName: 'PostToolUse',
      state: 'working',
      prompt: 'migrate the schema',
      agentType: 'claude',
      toolName: 'Bash'
    })

    vi.setSystemTime(1_200)
    expect(pressInterruptKey(server, 'plain-escape')).toBe(true)
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'done',
      interrupted: true
    })
  })

  it('still infers Ctrl+C during an open tool call', () => {
    const server = new AgentHookServer()
    ingest(server, {
      source: 'claude',
      hookEventName: 'PreToolUse',
      state: 'working',
      prompt: 'migrate the schema',
      agentType: 'claude',
      toolName: 'Bash'
    })

    vi.setSystemTime(1_200)
    expect(pressInterruptKey(server, 'ctrl-c')).toBe(true)
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'done',
      interrupted: true
    })
  })

  it('keeps a genuine Claude interrupt hook authoritative during an open tool call', () => {
    const server = new AgentHookServer()
    ingest(server, {
      source: 'claude',
      hookEventName: 'PreToolUse',
      state: 'working',
      prompt: 'migrate the schema',
      agentType: 'claude',
      toolName: 'Bash'
    })
    vi.setSystemTime(1_200)
    expect(pressInterruptKey(server, 'plain-escape')).toBe(false)

    vi.setSystemTime(1_400)
    ingest(server, {
      source: 'claude',
      hookEventName: 'Stop',
      state: 'done',
      prompt: 'migrate the schema',
      agentType: 'claude',
      interrupted: true
    })

    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'done',
      interrupted: true
    })
  })

  it('keeps Claude AskUserQuestion dismissal working while its PreToolUse row waits', () => {
    const server = new AgentHookServer()
    ingest(server, {
      source: 'claude',
      hookEventName: 'PreToolUse',
      state: 'waiting',
      prompt: 'pick a branch name',
      agentType: 'claude',
      toolName: 'AskUserQuestion'
    })

    vi.setSystemTime(1_200)
    expect(pressInterruptKey(server, 'plain-escape')).toBe(true)
    // Why: dismissal restores the lead state the question displaced, so the waiting card clears.
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working'
    })
  })

  it('leaves OpenCode and Copilot double Escape unchanged during an open tool call', () => {
    for (const agentType of ['opencode', 'copilot'] as const) {
      _internals.resetCachesForTests()
      const server = new AgentHookServer()
      ingest(server, {
        source: agentType,
        hookEventName: 'PreToolUse',
        state: 'working',
        prompt: 'build the bundle',
        agentType
      })

      vi.setSystemTime(1_200)
      expect(pressInterruptKey(server, 'plain-escape')).toBe(false)
      vi.setSystemTime(1_400)
      expect(pressInterruptKey(server, 'plain-escape', 2)).toBe(true)
      expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
        state: 'done',
        interrupted: true
      })
      vi.setSystemTime(1_000)
    }
  })

  it('leaves Droid Ctrl+C unchanged during an open tool call', () => {
    const server = new AgentHookServer()
    ingest(server, {
      source: 'droid',
      hookEventName: 'PreToolUse',
      state: 'working',
      prompt: 'run the suite',
      agentType: 'droid'
    })

    vi.setSystemTime(1_200)
    expect(pressInterruptKey(server, 'ctrl-c')).toBe(false)
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working'
    })
  })

  it('rejects a navigation Escape that also has an active child or a stale baseline', () => {
    const server = new AgentHookServer()
    ingest(server, {
      source: 'claude',
      hookEventName: 'PreToolUse',
      state: 'working',
      prompt: 'review loop',
      agentType: 'claude',
      subagents: [{ id: 'a1', state: 'working', startedAt: 900 }]
    })
    vi.setSystemTime(1_200)
    expect(pressInterruptKey(server, 'plain-escape')).toBe(false)
    expect(pressInterruptKey(server, 'ctrl-c')).toBe(false)

    // Why: a stale baseline is refused ahead of the navigation guard, for either intent.
    vi.setSystemTime(1_000 + 31 * 60 * 1000)
    expect(pressInterruptKey(server, 'plain-escape')).toBe(false)
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working'
    })
  })
})

/** The guard has to hold on the path a real agent CLI uses, not only on ingestRemote: the
 *  loopback listener is what stamps `hookEventName` for a locally launched agent. */
describe('navigation Escape over the loopback hook listener', () => {
  it.each([
    ['PreToolUse', false, 'working'],
    ['PostToolUse', true, 'done']
  ])(
    'a Claude row last seen on %s answers %s to a single Escape',
    async (hookEventName, expectedInference, expectedState) => {
      vi.useRealTimers()
      const server = new AgentHookServer()
      await server.start({ env: 'production' })
      try {
        await postHookEvent(
          server,
          buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'migrate the schema' })
        )
        await postHookEvent(
          server,
          buildBody({
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'pnpm migrate' }
          })
        )
        if (hookEventName === 'PostToolUse') {
          await postHookEvent(
            server,
            buildBody({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })
          )
        }

        expect(pressInterruptKey(server, 'plain-escape')).toBe(expectedInference)
        expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
          state: expectedState,
          ...(expectedInference ? { interrupted: true } : {})
        })
      } finally {
        server.stop()
      }
    }
  )
})
