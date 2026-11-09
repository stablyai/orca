import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { createHookListenerState } from '../../../../../shared/agent-hook-listener/listener-state'
import { pollCodexTranscriptStatus } from '../../../../../shared/agent-hook-listener/providers/codex-transcript-poll'
import { transcriptPollUpdate } from '../../../../../shared/agent-hook-listener/transcript-poll-policy'
import { buildRelayHookEnvelope } from '../../../../../wsl-guest/agent-hook-envelope-build'
import { buildCachedPaneReplayEnvelope } from '../../../../../wsl-guest/agent-hook-cached-pane-status'
import type { AgentHookEventPayload } from '../../../../../shared/agent-hook-listener/listener-event'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { PANE, buildBody } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

const CHILD = '01a16839-7f84-7ed3-aebf-ea51e50330cf'
const SECOND_CHILD = '02a16839-7f84-7ed3-aebf-ea51e50330cf'
const line = (type: string): string =>
  `${JSON.stringify({ type: 'event_msg', payload: { type } })}\n`

let directory: string

beforeEach(() => {
  _internals.resetCachesForTests()
  directory = mkdtempSync(join(tmpdir(), 'orca-remote-codex-child-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('remote Codex transcript completion', () => {
  it('retires transcript-completed children while keeping surviving child work live', () => {
    const parentPath = join(directory, 'rollout-parent.jsonl')
    const childPath = join(directory, `rollout-child-${CHILD}.jsonl`)
    const secondChildPath = join(directory, `rollout-child-${SECOND_CHILD}.jsonl`)
    writeFileSync(parentPath, line('task_complete'))
    writeFileSync(childPath, line('task_started'))
    writeFileSync(secondChildPath, line('task_started'))
    const hostState = createHookListenerState()
    const server = new AgentHookServer()
    const root = normalizeHookPayload(
      hostState,
      'codex',
      buildBody({
        hook_event_name: 'Stop',
        session_id: 'root',
        transcript_path: parentPath
      }),
      'production'
    )
    if (!root) {
      throw new Error('Root hook was rejected')
    }
    server.ingestRemote(buildRelayHookEnvelope(root, 'codex'), 'wsl:Ubuntu')

    const childBody = buildBody({
      hook_event_name: 'SubagentStart',
      agent_id: CHILD,
      session_id: CHILD,
      transcript_path: childPath
    })
    const started = normalizeHookPayload(hostState, 'codex', childBody, 'production')
    if (!started) {
      throw new Error('Child hook was rejected')
    }
    server.ingestRemote(buildRelayHookEnvelope(started, 'codex'), 'wsl:Ubuntu')
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        state: 'working',
        subagents: [
          {
            id: CHILD,
            state: 'working',
            startedAt: expect.any(Number)
          }
        ]
      })
    ])

    const secondChildBody = buildBody({
      hook_event_name: 'SubagentStart',
      agent_id: SECOND_CHILD,
      session_id: SECOND_CHILD,
      transcript_path: secondChildPath
    })
    const secondStarted = normalizeHookPayload(hostState, 'codex', secondChildBody, 'production')
    if (!secondStarted) {
      throw new Error('Second child hook was rejected')
    }
    server.ingestRemote(buildRelayHookEnvelope(secondStarted, 'codex'), 'wsl:Ubuntu')
    expect(
      server
        .getStatusSnapshot()[0]
        .subagents?.map((child) => child.id)
        .sort()
    ).toEqual([CHILD, SECOND_CHILD])

    const compact = normalizeHookPayload(
      hostState,
      'codex',
      buildBody({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'root' }),
      'production'
    )
    if (!compact) {
      throw new Error('Root compact was rejected')
    }
    server.ingestRemote(buildRelayHookEnvelope(compact, 'codex'), 'wsl:Ubuntu')
    const beforeReplay = server.getStatusSnapshot()[0]
    expect(beforeReplay).toMatchObject({
      mainAgent: { state: 'done' },
      subagents: [{ id: CHILD }, { id: SECOND_CHILD }]
    })
    server.ingestRemote(
      buildCachedPaneReplayEnvelope({ event: compact, meta: { source: 'codex' } }),
      'wsl:Ubuntu'
    )
    expect(server.getStatusSnapshot()[0]).toEqual(beforeReplay)

    appendFileSync(childPath, line('task_complete'))
    const oneRemaining = pollCodexTranscriptStatus(
      hostState,
      secondStarted,
      secondChildBody,
      'production'
    )
    if (!oneRemaining) {
      throw new Error('No first child completion status')
    }
    const partialUpdate = transcriptPollUpdate('codex', secondStarted, oneRemaining)
    if (!partialUpdate) {
      throw new Error('Host did not publish first child completion')
    }
    expect(partialUpdate).toMatchObject({
      toolAgentId: SECOND_CHILD,
      payload: {
        state: 'working',
        mainAgent: { state: 'done' },
        subagents: [expect.objectContaining({ id: SECOND_CHILD, state: 'working' })]
      }
    })
    expect(partialUpdate.hookEventName).toBeUndefined()
    server.ingestRemote(buildRelayHookEnvelope(partialUpdate, 'codex'), 'wsl:Ubuntu')
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      subagents: [expect.objectContaining({ id: SECOND_CHILD, state: 'working' })]
    })

    appendFileSync(secondChildPath, line('task_complete'))
    const polled = pollCodexTranscriptStatus(
      hostState,
      partialUpdate,
      secondChildBody,
      'production'
    )
    if (!polled) {
      throw new Error('No completion status')
    }
    const update = transcriptPollUpdate('codex', partialUpdate, polled)
    if (!update) {
      throw new Error('Host did not publish transcript completion')
    }
    expect(update).toMatchObject({ toolAgentId: SECOND_CHILD, payload: { state: 'done' } })
    expect(update.hookEventName).toBeUndefined()
    expect(update.payload.subagents).toBeUndefined()

    server.ingestRemote(buildRelayHookEnvelope(update, 'codex'), 'wsl:Ubuntu')

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        state: 'done',
        mainAgent: expect.objectContaining({ state: 'done' })
      })
    ])
    expect(server.getStatusSnapshot()[0].subagents).toBeUndefined()
  })
})

describe('remote Codex unlabelled roster removals', () => {
  const childStart = (id: string, startedAt: number): AgentHookEventPayload => ({
    paneKey: PANE,
    connectionId: null,
    source: 'codex',
    providerSession: { key: 'session_id', id: 'root' },
    hookEventName: 'SubagentStart',
    toolAgentId: id,
    payload: {
      agentType: 'codex',
      prompt: 'Run the checks',
      state: 'working',
      mainAgent: { state: 'working', stateStartedAt: 1 },
      subagents: [{ id, state: 'working', startedAt }]
    }
  })
  const emptyPoll = (mainState: 'working' | 'done', toolAgentId?: string) => ({
    paneKey: PANE,
    source: 'codex',
    providerSession: { key: 'session_id', id: 'root' },
    toolAgentId,
    payload: {
      agentType: 'codex',
      prompt: 'Run the checks',
      state: mainState,
      mainAgent: { state: mainState, stateStartedAt: 1 }
    }
  })

  it('keeps children a restarted relay never listed', () => {
    const server = new AgentHookServer()
    server.beginRemoteRelaySession('wsl:Ubuntu')
    server.ingestRemote(childStart(CHILD, 1), 'wsl:Ubuntu')
    server.beginRemoteRelaySession('wsl:Ubuntu')
    const replay = buildCachedPaneReplayEnvelope({
      event: { ...childStart(CHILD, 1), hookEventName: 'SessionStart', toolAgentId: undefined },
      meta: { source: 'codex' }
    })
    server.ingestRemote(replay, 'wsl:Ubuntu')
    server.ingestRemote(emptyPoll('done'), 'wsl:Ubuntu')
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ id: CHILD })]
    })
    server._getStateForTests().codexSubagentRosterByPaneKey.delete(PANE)
    server.ingestRemote(replay, 'wsl:Ubuntu')
    server.ingestRemote(emptyPoll('done'), 'wsl:Ubuntu')
    expect(server.getStatusSnapshotForPane(PANE)[0]?.subagents?.map((child) => child.id)).toEqual([
      CHILD
    ])

    server.ingestRemote(childStart(CHILD, 1), 'wsl:Ubuntu')
    server.ingestRemote(emptyPoll('done'), 'wsl:Ubuntu')
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({ state: 'done' })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.subagents).toBeUndefined()
  })

  it.each([100, 1000])(
    'releases %i completed child lifetimes across cached starts',
    (lifetimes) => {
      const server = new AgentHookServer()
      const state = server._getStateForTests()
      server.beginRemoteRelaySession('wsl:Ubuntu')
      server.ingestRemote(childStart(CHILD, 1), 'wsl:Ubuntu')
      for (let index = 0; index < lifetimes; index++) {
        const next = childStart(`completed-${index}`, index + 2)
        server.ingestRemote(next, 'wsl:Ubuntu')
        server.ingestRemote(
          buildCachedPaneReplayEnvelope({
            event: { ...next, hookEventName: 'SessionStart', toolAgentId: undefined },
            meta: { source: 'codex' }
          }),
          'wsl:Ubuntu'
        )
        server.ingestRemote(
          {
            ...emptyPoll('done'),
            payload: {
              ...emptyPoll('done').payload,
              subagents: [{ id: CHILD, state: 'working', startedAt: 1 }]
            }
          },
          'wsl:Ubuntu'
        )
        expect(
          server.getStatusSnapshotForPane(PANE)[0]?.subagents?.map((child) => child.id)
        ).toEqual([CHILD])
        expect(state.codexSubagentRosterByPaneKey.get(PANE)?.size).toBe(1)
      }
      server.ingestRemote(emptyPoll('done'), 'wsl:Ubuntu')
      expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({ state: 'done' })
      expect(server.getStatusSnapshotForPane(PANE)[0]?.subagents).toBeUndefined()
      expect(state.codexSubagentRosterByPaneKey.get(PANE)?.size).toBe(0)
    }
  )
})
