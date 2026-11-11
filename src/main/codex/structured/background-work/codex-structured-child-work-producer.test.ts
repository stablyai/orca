import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import {
  acquireReadyCodexForTest,
  fakeCodex,
  identityFor,
  THREAD_ID
} from '../session-lifecycle/codex-structured-session-adapter-fixture'
import { describe, expect, it } from 'vitest'
import {
  foldAgentLeadStatus,
  type AgentLeadStatusResolution
} from '../../../../shared/agent-status/lifecycle/agent-lead-status-fold'
import { createAgentChildWorkAdmission } from '../../../../shared/agent-status/child-work/agent-status-child-work-admission'
import type { AgentChildWorkRecord } from '../../../../shared/agent-status/child-work/agent-status-child-work'
import { agentChildWorkLiveness } from '../../../../shared/agent-status/child-work/agent-status-child-work-liveness'
import { reconcileAgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-reconciliation'
import {
  agentChildWorkOwnedLiveness,
  deriveAgentChildDisplayState
} from '../../../../shared/agent-status/child-work/agent-status-child-work-display'
import { projectAgentChildWorkViews } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import { createAgentStatusStore } from '../../../../shared/agent-status/store/agent-status-store'
import { makeStructuredAgentStatusSubject } from '../../../../shared/agent-status/contracts/agent-status-subject'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { CodexStructuredSessionAdapter } from '../session-lifecycle/codex-structured-session-adapter'

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

type Frame = { method: string; params: Record<string, unknown> }
type Liveness = ReturnType<typeof agentChildWorkLiveness>

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

async function producer() {
  const codex = fakeCodex()
  const store = createAgentStatusStore({ epoch: 'epoch-1', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  let minted = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: () => `child-${++minted}`
  })
  const records = (): AgentChildWorkRecord[] => store.getChildren(parent)
  const recordedLiveness = () =>
    agentChildWorkLiveness(records().filter((record) => record.membership === 'live'))
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
      reconcileAgentChildWorkEvidence({ store, admission, parent, provider: 'codex', evidence })
    }
  })
  const journal: StructuredAgentSessionEventSink = {
    appendItem: () => {},
    appendTombstone: () => {},
    publish: () => {}
  }
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9',
    events: journal
  })
  const send = (frame: Frame): void => {
    codex.connections[0]!.handlers.onNotification?.(frame.method, frame.params)
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
  return {
    adapter,
    codex,
    send,
    records,
    recordedLiveness,
    byDescription,
    display
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
  it('delivers pending previews once across late announcements and verdict refinements', () => {
    const tracker = new CodexBackgroundTaskTracker(THREAD_ID)
    const send = (frame: Frame) => {
      tracker.observe({ ...frame, threadId: String(frame.params.threadId) })
      return tracker.drainChildWorkEvidence(100)
    }
    const message = (turnId: string, text: string) =>
      item('item/completed', REVIEWER, turnId, {
        type: 'agentMessage',
        id: `reply-${text}`,
        text
      })
    send(turn('turn/started', REVIEWER, 'r1'))
    send(message('r1', 'before announcement'))
    expect(send({ method: 'thread/closed', params: { threadId: REVIEWER } })).toEqual([])
    expect(send(spawned(REVIEWER, 'review', 'p1'))).toEqual([
      expect.objectContaining({ type: 'ended', lastMessage: 'before announcement' })
    ])
    expect(send(message('r1', 'refined reply'))).toEqual([])
    expect(send(turn('turn/completed', REVIEWER, 'r1'))).toEqual([
      expect.objectContaining({ type: 'ended', outcome: 'succeeded', lastMessage: 'refined reply' })
    ])
    send(message('r2', 'future reply'))
    expect(send(turn('turn/started', REVIEWER, 'r2'))).toEqual([
      expect.objectContaining({
        type: 'live',
        child: expect.objectContaining({ lastMessage: 'future reply' })
      })
    ])
    expect(send({ method: 'thread/closed', params: { threadId: REVIEWER } })).toEqual([
      expect.objectContaining({ type: 'ended', lastMessage: 'future reply' })
    ])
    expect(send(turn('turn/completed', REVIEWER, 'r2'))).toEqual([
      {
        type: 'ended',
        observedAt: 100,
        handle: { idKind: 'thread_id', id: REVIEWER, runId: 'r2' },
        outcome: 'succeeded'
      }
    ])
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
})
