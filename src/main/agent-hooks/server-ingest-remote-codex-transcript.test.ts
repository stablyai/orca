import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createShedSubagentsField } from '../../shared/agent-hook-relay'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { pollCodexTranscriptStatus } from '../../shared/agent-hook-listener/providers/codex-transcript-poll'
import { transcriptPollUpdate } from '../../shared/agent-hook-listener/transcript-poll-policy'
import { buildRelayHookEnvelope } from '../../wsl-guest/agent-hook-envelope-build'
import { AgentHookServer, _internals } from './server'
import { PANE, buildBody } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
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

describe('remote Codex truncated transcript snapshots', () => {
  it('keeps live work when a changed roster was shed to fit the relay frame', () => {
    const server = new AgentHookServer()
    const children = [
      { id: CHILD, state: 'working' as const, startedAt: 1 },
      { id: SECOND_CHILD, state: 'working' as const, startedAt: 2 }
    ]
    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'codex',
        hookEventName: 'SubagentStart',
        toolAgentId: SECOND_CHILD,
        payload: {
          agentType: 'codex',
          prompt: 'Run the checks',
          state: 'working',
          mainAgent: { state: 'done', stateStartedAt: 1 },
          subagents: children
        }
      },
      'wsl:Ubuntu'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'codex',
        toolAgentId: SECOND_CHILD,
        shedFields: [createShedSubagentsField([children[1]!])],
        payload: {
          agentType: 'codex',
          prompt: 'Run the checks',
          state: 'working',
          mainAgent: { state: 'done', stateStartedAt: 1 }
        }
      },
      'wsl:Ubuntu'
    )
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({ state: 'working' })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.subagents).toHaveLength(2)
  })

  it('keeps a shed roster when an unlabelled root poll reports a done main agent', () => {
    const server = new AgentHookServer()
    const child = { id: CHILD, state: 'working' as const, startedAt: 1 }
    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'codex',
        hookEventName: 'SubagentStart',
        toolAgentId: CHILD,
        payload: {
          agentType: 'codex',
          prompt: 'Run the checks',
          state: 'working',
          mainAgent: { state: 'working', stateStartedAt: 1 },
          subagents: [child]
        }
      },
      'wsl:Ubuntu'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'codex',
        shedFields: [createShedSubagentsField([{ ...child, description: 'changed' }])],
        payload: {
          agentType: 'codex',
          prompt: 'Run the checks',
          state: 'working',
          mainAgent: { state: 'done', stateStartedAt: 2 }
        }
      },
      'wsl:Ubuntu'
    )
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      subagents: [expect.objectContaining({ id: CHILD })]
    })
  })
})

describe('remote Codex unlabelled roster removals', () => {
  const childStart = (id: string, startedAt: number) => ({
    paneKey: PANE,
    source: 'codex',
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
    toolAgentId,
    payload: {
      agentType: 'codex',
      prompt: 'Run the checks',
      state: mainState,
      mainAgent: { state: mainState, stateStartedAt: 1 }
    }
  })

  it('retires the last child while the root keeps working', () => {
    const server = new AgentHookServer()
    server.ingestRemote(childStart(CHILD, 1), 'wsl:Ubuntu')
    server.ingestRemote(emptyPoll('working', CHILD), 'wsl:Ubuntu')
    const row = server.getStatusSnapshotForPane(PANE)[0]
    expect(row).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    expect(row?.subagents).toBeUndefined()
  })

  it('keeps children a restarted relay never listed', () => {
    const server = new AgentHookServer()
    server.beginRemoteRelaySession('wsl:Ubuntu')
    server.ingestRemote(childStart(CHILD, 1), 'wsl:Ubuntu')
    server.beginRemoteRelaySession('wsl:Ubuntu')
    server.ingestRemote(emptyPoll('done'), 'wsl:Ubuntu')
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ id: CHILD })]
    })

    server.ingestRemote(childStart(CHILD, 1), 'wsl:Ubuntu')
    server.ingestRemote(emptyPoll('done'), 'wsl:Ubuntu')
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({ state: 'done' })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.subagents).toBeUndefined()
  })
})
