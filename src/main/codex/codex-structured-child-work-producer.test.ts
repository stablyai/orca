// A Codex session's frames, through the real adapter, into the host's child records: the order the
// host receives them in, and the parent row they fold to, written out step by step.

import { describe, expect, it } from 'vitest'
import { foldAgentLeadStatus } from '../../shared/agent-lead-status-fold'
import { createAgentChildWorkAdmission } from '../../shared/agent-status-child-work-admission'
import type { AgentChildWorkRecord } from '../../shared/agent-status-child-work'
import { agentChildWorkLiveness } from '../../shared/agent-status-child-work-liveness'
import { reconcileAgentChildWorkEvidence } from '../../shared/agent-status-child-work-reconciliation'
import {
  agentChildWorkOwnedLiveness,
  deriveAgentChildDisplayState
} from '../../shared/agent-status-child-work-display'
import { projectAgentChildWorkViews } from '../../shared/agent-status-child-work-view'
import { createAgentStatusStore } from '../../shared/agent-status-store'
import { agentJournalLinkageFields } from '../../shared/agent-session-journal-producer'
import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage
} from '../../shared/agent-session-journal-types'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { fakeCodex, identityFor, THREAD_ID } from './codex-structured-session-adapter-fixture'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'

const parent = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'folder'
  },
  'session-1'
)
const REVIEWER = 'thread-reviewer'
const TESTER = 'thread-tester'
const LINTER = 'thread-linter'

type Frame = { method: string; params: Record<string, unknown> }
type Delivery = { kind: 'journal' | 'publish' | 'evidence'; detail: string }

const turn = (
  method: 'turn/started' | 'turn/completed',
  threadId: string,
  id: string,
  status = 'completed'
): Frame => ({
  method,
  params: { threadId, turn: { id, status } }
})
const spawned = (child: string, name: string, parentTurn: string): Frame => ({
  method: 'item/started',
  params: {
    threadId: THREAD_ID,
    turnId: parentTurn,
    item: {
      type: 'subAgentActivity',
      id: `spawn-${child}`,
      kind: 'started',
      agentThreadId: child,
      agentPath: `/root/${name}`
    }
  }
})
const item = (
  method: 'item/started' | 'item/completed',
  threadId: string,
  turnId: string,
  fields: Record<string, unknown>
): Frame => ({
  method,
  params: { threadId, turnId, item: fields }
})
const status = (threadId: string, activeFlags: string[]): Frame => ({
  method: 'thread/status/changed',
  params: { threadId, status: { type: 'active', activeFlags } }
})

async function producer() {
  const codex = fakeCodex()
  const store = createAgentStatusStore({ epoch: 'epoch-1', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  let minted = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: () => `child-${++minted}`
  })
  const deliveries: Delivery[] = []
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null
    }),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    onChildWorkEvidence: (sessionId, evidence) => {
      expect(sessionId).toBe('session-1')
      deliveries.push({ kind: 'evidence', detail: evidence.map((edge) => edge.type).join(',') })
      reconcileAgentChildWorkEvidence({ store, admission, parent, provider: 'codex', evidence })
    }
  })
  const rows: { body: AgentJournalItemBody; linkage: AgentJournalProducerLinkage }[] = []
  const journal: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => {
      deliveries.push({ kind: 'journal', detail: JSON.stringify(identity) })
      rows.push({ body, linkage: agentJournalLinkageFields(options) })
    },
    appendTombstone: () => {},
    // Production's journal publication is what republishes the parent's own row.
    publish: () => deliveries.push({ kind: 'publish', detail: '' })
  }
  await adapter.acquire({
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9',
    events: journal
  })
  const send = (frame: Frame): Delivery[] => {
    const from = deliveries.length
    codex.connections[0]!.handlers.onNotification?.(frame.method, frame.params)
    return deliveries.slice(from)
  }
  const records = (): AgentChildWorkRecord[] => store.getChildren(parent)
  const byDescription = (description: string) =>
    records().find((record) => record.description === description)
  const display = (description: string) => {
    const children = records()
    const views = projectAgentChildWorkViews(
      children,
      children.flatMap((child) => store.getAliasesForChild(child.childWorkId))
    )
    const view = views.find((candidate) => candidate.description === description)
    return view && deriveAgentChildDisplayState(view, agentChildWorkOwnedLiveness(views, view.id))
  }
  /** The producer stamp on the newest journal row that carries this text. */
  const stampOf = (text: string) =>
    rows.findLast((row) => JSON.stringify(row.body).includes(text))?.linkage
  return { adapter, codex, send, records, byDescription, display, stampOf }
}

describe('Codex structured child-work producer', () => {
  it('delivers evidence only after the journal wrote and published the frame', async () => {
    const { send, records } = await producer()
    send(turn('turn/started', THREAD_ID, 'p1'))
    send(turn('turn/started', REVIEWER, 'r1'))
    const deliveries = send(spawned(REVIEWER, 'review', 'p1'))
    const kinds = deliveries.map((delivery) => delivery.kind)
    // The frame's own rows, then the parent's republished row, and only then its children.
    expect(kinds.filter((kind) => kind === 'journal').length).toBeGreaterThan(0)
    expect(kinds.lastIndexOf('publish')).toBeGreaterThan(kinds.lastIndexOf('journal'))
    expect(kinds.at(-1)).toBe('evidence')
    expect(kinds.filter((kind) => kind === 'evidence')).toHaveLength(1)
    expect(records()).toEqual([
      expect.objectContaining({ description: 'review', membership: 'live' })
    ])
  })

  it("folds the parent from the records, frame by frame, with each child's outcome and activity", async () => {
    const { adapter, send, records, byDescription, display } = await producer()
    const steps: {
      frame: Frame
      lead: 'working' | 'done'
      live: ReturnType<typeof agentChildWorkLiveness>
      parent: ReturnType<typeof foldAgentLeadStatus>
      check?: () => void
    }[] = [
      {
        frame: turn('turn/started', THREAD_ID, 'p1'),
        lead: 'working',
        live: null,
        parent: { stateName: 'working' }
      },
      // Codex reports the child's turn before its announcement.
      {
        frame: turn('turn/started', REVIEWER, 'r1'),
        lead: 'working',
        live: null,
        parent: { stateName: 'working' },
        check: () => expect(records()).toEqual([])
      },
      {
        frame: spawned(REVIEWER, 'review', 'p1'),
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' }
      },
      {
        frame: item('item/started', REVIEWER, 'r1', {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'npm test',
          source: 'agent',
          status: 'inProgress'
        }),
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' },
        check: () =>
          expect(byDescription('review')?.operation).toMatchObject({
            toolName: 'Bash',
            input: 'npm test',
            basis: 'open'
          })
      },
      // The child leaves a dev server running past its own turn.
      {
        frame: item('item/started', REVIEWER, 'r1', {
          type: 'commandExecution',
          id: 'exec-1',
          command: 'npm run dev',
          source: 'unifiedExecStartup',
          status: 'inProgress'
        }),
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' },
        check: () =>
          expect(byDescription('npm run dev')?.parentChildWorkId).toBe(
            byDescription('review')?.childWorkId
          )
      },
      {
        frame: item('item/completed', REVIEWER, 'r1', {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'npm test',
          source: 'agent',
          status: 'completed',
          exitCode: 0
        }),
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' },
        check: () => expect(byDescription('review')?.operation).toBeUndefined()
      },
      {
        frame: item('item/completed', REVIEWER, 'r1', {
          type: 'agentMessage',
          id: 'msg-1',
          text: 'Dev server is up'
        }),
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' }
      },
      // The parent's turn ends first; its child keeps running.
      {
        frame: turn('turn/completed', THREAD_ID, 'p1'),
        lead: 'done',
        live: 'working',
        parent: { stateName: 'working' },
        check: () =>
          expect(byDescription('review')).toMatchObject({ membership: 'live', state: 'working' })
      },
      // Only the records say a child waits, and the shared fold ranks that wait above the parent's
      // own state.
      {
        frame: status(REVIEWER, ['waitingOnApproval']),
        lead: 'done',
        live: 'waiting',
        parent: { stateName: 'waiting' },
        check: () => expect(byDescription('review')?.state).toBe('waiting')
      },
      {
        frame: status(REVIEWER, []),
        lead: 'done',
        live: 'working',
        parent: { stateName: 'working' }
      },
      {
        frame: turn('turn/completed', REVIEWER, 'r1'),
        lead: 'done',
        live: 'monitoring',
        parent: { stateName: 'working', workingMode: 'monitoring' },
        check: () => {
          expect(byDescription('review')).toMatchObject({
            membership: 'settled',
            outcome: 'succeeded',
            lastMessage: 'Dev server is up'
          })
          // Finished, but a shell it launched still runs: the CLI parent rule reads monitoring.
          expect(display('review')).toBe('monitoring')
        }
      },
      {
        frame: turn('turn/started', THREAD_ID, 'p2'),
        lead: 'working',
        live: 'monitoring',
        parent: { stateName: 'working' }
      },
      // The parent asks the finished child a follow-up: the same record, a new run.
      {
        frame: turn('turn/started', REVIEWER, 'r2'),
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' },
        check: () =>
          expect(byDescription('review')).toMatchObject({
            childWorkId: 'child-1',
            membership: 'live',
            invocation: { invocationId: 'r2', generation: 2 },
            previousInvocations: [expect.objectContaining({ outcome: 'succeeded' })]
          })
      },
      {
        frame: spawned(TESTER, 'test', 'p2'),
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' }
      },
      {
        frame: turn('turn/started', TESTER, 't1'),
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' }
      },
      {
        frame: spawned(LINTER, 'lint', 'p2'),
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' }
      },
      {
        frame: turn('turn/started', LINTER, 'l1'),
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' }
      },
      // Codex ends this child's turn with an error it will not retry, and no turn/completed.
      {
        frame: {
          method: 'error',
          params: { threadId: LINTER, turnId: 'l1', willRetry: false, error: { message: 'boom' } }
        },
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' },
        check: () =>
          expect(byDescription('lint')).toMatchObject({ membership: 'settled', outcome: 'failed' })
      },
      {
        frame: turn('turn/completed', REVIEWER, 'r2', 'interrupted'),
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' },
        check: () =>
          expect(byDescription('review')).toMatchObject({
            membership: 'settled',
            outcome: 'cancelled'
          })
      },
      {
        frame: turn('turn/completed', THREAD_ID, 'p2'),
        lead: 'done',
        live: 'working',
        parent: { stateName: 'working' }
      },
      {
        frame: turn('turn/completed', TESTER, 't1', 'failed'),
        lead: 'done',
        live: 'monitoring',
        parent: { stateName: 'working', workingMode: 'monitoring' },
        check: () =>
          expect(byDescription('test')).toMatchObject({ membership: 'settled', outcome: 'failed' })
      },
      {
        frame: item('item/completed', REVIEWER, 'r1', {
          type: 'commandExecution',
          id: 'exec-1',
          command: 'npm run dev',
          source: 'unifiedExecStartup',
          status: 'completed',
          exitCode: 0
        }),
        lead: 'done',
        live: null,
        parent: { stateName: 'done' },
        check: () => {
          expect(byDescription('npm run dev')).toMatchObject({
            membership: 'settled',
            outcome: 'succeeded'
          })
          expect(display('review')).toBe('interrupted')
        }
      }
    ]
    for (const [index, step] of steps.entries()) {
      send(step.frame)
      const live = agentChildWorkLiveness(
        records().filter((record) => record.membership === 'live')
      )
      const parent = foldAgentLeadStatus({ leadState: step.lead, childWorkLiveness: live })
      expect({ index, live, parent }).toEqual({ index, live: step.live, parent: step.parent })
      step.check?.()
    }
    const settled = records()
    await adapter.closeSession('session-1')
    // Every child had already ended; closing the session changes none of what they said.
    expect(records()).toEqual(settled)
    expect(
      records().map(({ description, membership, outcome }) => ({
        description,
        membership,
        outcome
      }))
    ).toEqual([
      { description: 'review', membership: 'settled', outcome: 'cancelled' },
      { description: 'npm run dev', membership: 'settled', outcome: 'succeeded' },
      { description: 'test', membership: 'settled', outcome: 'failed' },
      { description: 'lint', membership: 'settled', outcome: 'failed' }
    ])
    expect(adapter.backgroundTaskState('session-1')).toBeUndefined()
  })

  it("numbers a child's runs as the journal does: a row's attempt is its record's generation", async () => {
    const { send, byDescription, stampOf } = await producer()
    const says = (turnId: string, text: string) =>
      item('item/completed', REVIEWER, turnId, { type: 'agentMessage', id: `msg-${text}`, text })
    // The journal stamps a child row with its run only once it is past the first.
    const runs = (text: string) => {
      const stamp = stampOf(text)
      return {
        agentId: stamp?.agentId,
        attempt: stamp ? (stamp.attempt ?? 1) : undefined,
        generation: byDescription('review')?.invocation.generation
      }
    }
    send(turn('turn/started', THREAD_ID, 'p1'))
    // Codex reports the child's first turn before the spawn that announces it.
    send(turn('turn/started', REVIEWER, 'r1'))
    send(spawned(REVIEWER, 'review', 'p1'))
    send(says('r1', 'run 1'))
    expect(runs('run 1')).toEqual({ agentId: REVIEWER, attempt: 1, generation: 1 })
    send(turn('turn/completed', REVIEWER, 'r1'))
    // Each follow-up the parent sends is the child's next run, on both sides.
    for (const run of [2, 3]) {
      send(turn('turn/started', REVIEWER, `r${run}`))
      send(says(`r${run}`, `run ${run}`))
      expect(runs(`run ${run}`)).toEqual({ agentId: REVIEWER, attempt: run, generation: run })
      send(turn('turn/completed', REVIEWER, `r${run}`))
    }
  })

  it('settles a live child with no reported outcome when the provider exits unexpectedly', async () => {
    const { codex, send, records } = await producer()
    send(turn('turn/started', THREAD_ID, 'p1'))
    send(spawned(REVIEWER, 'review', 'p1'))
    send(turn('turn/started', REVIEWER, 'r1'))
    expect(records()).toEqual([
      expect.objectContaining({ description: 'review', membership: 'live', state: 'working' })
    ])
    codex.connections[0]!.handlers.onExit?.(new Error('provider exited'))
    expect(records()).toEqual([
      expect.objectContaining({
        description: 'review',
        membership: 'settled',
        state: 'done',
        outcome: 'unknown'
      })
    ])
  })
})
