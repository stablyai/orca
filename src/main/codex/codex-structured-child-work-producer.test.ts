import {
  acquireReadyCodexForTest,
  fakeCodex,
  identityFor,
  THREAD_ID
} from './codex-structured-session-adapter-fixture'

import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  foldAgentLeadStatus,
  type AgentLeadStatusResolution
} from '../../shared/agent-lead-status-fold'
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
type Liveness = ReturnType<typeof agentChildWorkLiveness>
type JournalMoment = { recorded: Liveness; commandLive: boolean }

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
  const moments: JournalMoment[] = []
  const records = (): AgentChildWorkRecord[] => store.getChildren(parent)
  const recordedLiveness = () =>
    agentChildWorkLiveness(records().filter((record) => record.membership === 'live'))
  // Journal writes expose parent state, so sample child records at each write.
  const moment = () =>
    moments.push({
      recorded: recordedLiveness(),
      commandLive: records().some(
        (record) => record.kind === 'command' && record.membership === 'live'
      )
    })
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
      moment()
    },
    appendTombstone: () => {},
    // Match the host's parent-row publication point.
    publish: () => {
      deliveries.push({ kind: 'publish', detail: '' })
      moment()
    }
  }
  await acquireReadyCodexForTest(adapter, {
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
  const momentsOf = (frame: Frame): JournalMoment[] => {
    const from = moments.length
    send(frame)
    return moments.slice(from)
  }
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
  const stampOf = (text: string) =>
    rows.findLast((row) => JSON.stringify(row.body).includes(text))?.linkage
  return {
    adapter,
    codex,
    send,
    momentsOf,
    records,
    recordedLiveness,
    byDescription,
    display,
    stampOf
  }
}

const fold = (
  leadState: 'working' | 'done',
  childWorkLiveness: Liveness
): AgentLeadStatusResolution => foldAgentLeadStatus({ leadState, childWorkLiveness })
const shellFrame = (
  method: 'item/started' | 'item/completed',
  threadId: string,
  turnId: string,
  id: string,
  command: string,
  source = 'unifiedExecStartup'
): Frame =>
  item(method, threadId, turnId, {
    type: 'commandExecution',
    id,
    command,
    source,
    status: method === 'item/started' ? 'inProgress' : 'completed',
    ...(method === 'item/completed' ? { exitCode: 0 } : {})
  })

describe('Codex structured child-work producer', () => {
  it('delivers evidence only after the journal wrote and published the frame', async () => {
    const { send, records } = await producer()
    const deliveries = [
      ...send(turn('turn/started', THREAD_ID, 'p1')),
      ...send(turn('turn/started', REVIEWER, 'r1')),
      ...send(spawned(REVIEWER, 'review', 'p1'))
    ]
    const kinds = deliveries.map((delivery) => delivery.kind)
    expect(kinds.filter((kind) => kind === 'journal').length).toBeGreaterThan(0)
    expect(kinds.lastIndexOf('publish')).toBeGreaterThan(kinds.lastIndexOf('journal'))
    expect(kinds.at(-1)).toBe('evidence')
    expect(kinds.filter((kind) => kind === 'evidence')).toHaveLength(1)
    expect(records()).toEqual([
      expect.objectContaining({ description: 'review', membership: 'live' })
    ])
  })

  it("folds the parent from the records, at every journal write, with each child's outcome and activity", async () => {
    const { adapter, momentsOf, records, recordedLiveness, byDescription, display } =
      await producer()
    const steps: {
      frame: Frame
      lead: 'working' | 'done'
      live: Liveness
      parent: AgentLeadStatusResolution
      check?: () => void
    }[] = [
      {
        frame: turn('turn/started', THREAD_ID, 'p1'),
        lead: 'working',
        live: null,
        parent: { stateName: 'working' }
      },
      // Child turn notifications can precede their spawn announcement.
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
      // Approval starts use source=agent; exits arrive from unified exec.
      {
        frame: shellFrame('item/started', REVIEWER, 'r1', 'cmd-1', 'npm test', 'agent'),
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' },
        check: () => {
          expect(byDescription('review')?.operation).toMatchObject({
            toolName: 'Bash',
            input: 'npm test',
            basis: 'open'
          })
          expect(byDescription('npm test')).toMatchObject({
            membership: 'live',
            parentChildWorkId: byDescription('review')?.childWorkId
          })
        }
      },
      {
        frame: shellFrame('item/started', REVIEWER, 'r1', 'exec-1', 'npm run dev'),
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' },
        check: () =>
          expect(byDescription('npm run dev')).toMatchObject({
            membership: 'live',
            parentChildWorkId: byDescription('review')?.childWorkId
          })
      },
      {
        frame: shellFrame('item/completed', REVIEWER, 'r1', 'cmd-1', 'npm test'),
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' },
        check: () => {
          expect(byDescription('npm test')).toBeUndefined()
          expect(byDescription('review')?.operation).toMatchObject({
            toolName: 'Bash',
            input: 'npm run dev'
          })
        }
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
      {
        frame: turn('turn/completed', THREAD_ID, 'p1'),
        lead: 'done',
        live: 'working',
        parent: { stateName: 'working' },
        check: () =>
          expect(byDescription('review')).toMatchObject({ membership: 'live', state: 'working' })
      },
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
          expect(byDescription('npm run dev')).toMatchObject({
            membership: 'live',
            parentChildWorkId: byDescription('review')?.childWorkId
          })
          // Live descendants keep a settled child in monitoring state.
          expect(display('review')).toBe('monitoring')
        }
      },
      {
        frame: turn('turn/started', THREAD_ID, 'p2'),
        lead: 'working',
        live: 'monitoring',
        parent: { stateName: 'working' }
      },
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
      {
        frame: {
          method: 'error',
          params: { threadId: LINTER, turnId: 'l1', willRetry: false, error: { message: 'boom' } }
        },
        lead: 'working',
        live: 'working',
        parent: { stateName: 'working' },
        check: () => expect(byDescription('lint')).toMatchObject({ membership: 'live' })
      },
      {
        frame: turn('turn/completed', LINTER, 'l1', 'failed'),
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
        frame: shellFrame('item/completed', REVIEWER, 'r1', 'exec-1', 'npm run dev'),
        lead: 'done',
        live: null,
        parent: { stateName: 'done' },
        check: () => {
          expect(byDescription('npm run dev')).toBeUndefined()
          expect(display('review')).toBe('interrupted')
        }
      }
    ]
    let journalMoments = 0
    let before = steps[0].parent
    for (const [index, step] of steps.entries()) {
      const frameMoments = momentsOf(step.frame)
      journalMoments += frameMoments.length
      // Mid-frame publication may expose either boundary state, never done with a live command.
      for (const [at, { recorded, commandLive }] of frameMoments.entries()) {
        const parent = fold(step.lead, recorded)
        expect({
          index,
          at,
          parent: [before, step.parent].some((p) => isDeepStrictEqual(p, parent))
        }).toEqual({ index, at, parent: true })
        expect({ index, at, done: commandLive && parent.stateName === 'done' }).toEqual({
          index,
          at,
          done: false
        })
      }
      const live = recordedLiveness()
      expect({ index, live, parent: fold(step.lead, live) }).toEqual({
        index,
        live: step.live,
        parent: step.parent
      })
      before = step.parent
      step.check?.()
    }
    // Child-only changes can skip this parent's journal.
    expect(journalMoments).toBeGreaterThan(0)
    const settled = records()
    await adapter.closeSession('session-1')
    expect(records()).toEqual(settled)
    expect(
      records().map(({ description, membership, outcome }) => ({
        description,
        membership,
        outcome
      }))
    ).toEqual([
      { description: 'review', membership: 'settled', outcome: 'cancelled' },
      { description: 'test', membership: 'settled', outcome: 'failed' },
      { description: 'lint', membership: 'settled', outcome: 'failed' }
    ])
    expect(adapter.backgroundTaskState('session-1')).toBeUndefined()
  })

  it("never reads done while the main agent's own shell runs past its turn", async () => {
    const { momentsOf, send, recordedLiveness } = await producer()
    send(turn('turn/started', THREAD_ID, 'p1'))
    send(shellFrame('item/started', THREAD_ID, 'p1', 'exec-dev', 'npm run dev'))
    const monitoring = { stateName: 'working', workingMode: 'monitoring' }
    const turnEnd = momentsOf(turn('turn/completed', THREAD_ID, 'p1'))
    expect(turnEnd.length).toBeGreaterThan(0)
    for (const { recorded } of turnEnd) {
      expect(fold('done', recorded)).toEqual(monitoring)
    }
    expect(fold('done', recordedLiveness())).toEqual(monitoring)
    momentsOf(shellFrame('item/completed', THREAD_ID, 'p1', 'exec-dev', 'npm run dev'))
    expect(fold('done', recordedLiveness())).toEqual({ stateName: 'done' })
  })

  it('ends an approval left unanswered when its turn ends: Codex never ran the command', async () => {
    const { adapter, codex, send, records, recordedLiveness, display, byDescription } =
      await producer()
    const approve = (threadId: string, turnId: string, itemId: string, command: string) => {
      // Codex starts approval-path items before asking; turn end abandons unanswered prompts.
      send(shellFrame('item/started', threadId, turnId, itemId, command, 'agent'))
      codex.connections[0]!.handlers.onServerRequest?.({
        id: `approval-${itemId}`,
        method: 'item/commandExecution/requestApproval',
        params: { itemId, threadId, turnId }
      })
    }
    send(turn('turn/started', THREAD_ID, 'p1'))
    send(turn('turn/started', REVIEWER, 'r1'))
    send(spawned(REVIEWER, 'review', 'p1'))
    approve(REVIEWER, 'r1', 'call-child', 'npm run e2e')
    approve(THREAD_ID, 'p1', 'call-main', 'npm run dev')
    expect(records().filter((record) => record.kind === 'command')).toHaveLength(2)
    send(turn('turn/completed', REVIEWER, 'r1', 'interrupted'))
    expect(byDescription('npm run e2e')).toBeUndefined()
    expect(display('review')).toBe('interrupted')
    send(turn('turn/completed', THREAD_ID, 'p1', 'interrupted'))
    expect(byDescription('npm run dev')).toBeUndefined()
    expect(adapter.backgroundTaskState('session-1')).toBeNull()
    expect(fold('done', recordedLiveness())).toEqual({ stateName: 'done' })
  })

  it('keeps an answered approval running past its turn', async () => {
    const { adapter, codex, send, byDescription } = await producer()
    send(turn('turn/started', THREAD_ID, 'p1'))
    send(shellFrame('item/started', THREAD_ID, 'p1', 'call-1', 'npm run dev', 'agent'))
    codex.connections[0]!.handlers.onServerRequest?.({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'call-1', threadId: THREAD_ID, turnId: 'p1' }
    })
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId: 'call-1',
      kind: 'approval',
      response: { kind: 'option', optionId: 'accept' },
      fence: 7,
      commit: async () => {}
    })
    send(turn('turn/completed', THREAD_ID, 'p1'))
    expect(byDescription('npm run dev')).toMatchObject({ membership: 'live' })
    expect(adapter.backgroundTaskState('session-1')?.tasks).toEqual([
      expect.objectContaining({ kind: 'command', description: 'npm run dev' })
    ])
  })

  it("numbers a child's runs as the journal does: a row's attempt is its record's generation", async () => {
    const { send, byDescription, stampOf } = await producer()
    const says = (turnId: string, text: string) =>
      item('item/completed', REVIEWER, turnId, { type: 'agentMessage', id: `msg-${text}`, text })
    // First-run rows omit attempt; normalize them to generation 1.
    const runs = (text: string) => {
      const stamp = stampOf(text)
      return {
        agentId: stamp?.agentId,
        attempt: stamp ? (stamp.attempt ?? 1) : undefined,
        generation: byDescription('review')?.invocation.generation
      }
    }
    send(turn('turn/started', THREAD_ID, 'p1'))
    send(turn('turn/started', REVIEWER, 'r1'))
    send(spawned(REVIEWER, 'review', 'p1'))
    send(says('r1', 'run 1'))
    expect(runs('run 1')).toEqual({ agentId: REVIEWER, attempt: 1, generation: 1 })
    send(turn('turn/completed', REVIEWER, 'r1'))
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
