// A Claude session driven through the real adapter, with its child-work evidence reconciled into
// a store of its own or ingested by a real hook server.

import { expect } from 'vitest'
import { createAgentChildWorkAdmission } from '../../shared/agent-status-child-work-admission'
import type { AgentChildWorkRecord } from '../../shared/agent-status-child-work'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import {
  reconcileAgentChildWorkEvidence,
  type AgentChildWorkReconcileOutcome
} from '../../shared/agent-status-child-work-reconciliation'
import { createAgentStatusStore } from '../../shared/agent-status-store'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import { AgentHookServer } from '../agent-hooks/server'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { CapturedFrame } from './claude-captured-frame-builders.test-fixture'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

export const parent = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'folder'
  },
  'session-1'
)

let uuid = 0
export function frame(fields: Record<string, unknown>): Record<string, unknown> {
  return { session_id: PROVIDER_SESSION_ID, uuid: `frame-${++uuid}`, ...fields }
}
export function system(subtype: string, fields: Record<string, unknown>) {
  return frame({ type: 'system', subtype, ...fields })
}
export function toolUse(
  id: string,
  name: string,
  input: unknown,
  parentToolUseId: string | null = null
) {
  return frame({
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: {
      id: `msg-${id}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }]
    }
  })
}
export function toolResult(
  toolUseId: string,
  text: string,
  parentToolUseId: string | null = null,
  isError = false
) {
  return frame({
    type: 'user',
    parent_tool_use_id: parentToolUseId,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }]
    }
  })
}

type Delivery = { kind: 'journal' | 'publish' | 'evidence'; detail: string }

/** The host clock the adapter stamps evidence with; a replay moves it to each frame's time. */
export const T0 = 1_700_000_000_500

/** A real hook server already holding the session's parent row. */
export function hostWithParent(): AgentHookServer {
  const host = new AgentHookServer()
  host.ingestStructuredStatus(
    {
      sessionId: parent.sessionId,
      workspaceId: parent.workspaceId,
      agent: 'claude',
      status: 'working',
      hostExecutionOwned: true,
      latestPrompt: 'find the flaky tests',
      updatedAt: 100
    },
    parent
  )
  return host
}

/** With `host`, evidence goes through the host's own ingest instead of straight to reconciliation. */
export async function producer(host?: AgentHookServer) {
  const claude = fakeClaude()
  const store = createAgentStatusStore({ epoch: 'epoch-1', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: (() => {
      let minted = 0
      return () => `child-${++minted}`
    })()
  })
  let clock = T0
  const deliveries: Delivery[] = []
  /** The producer linkage the journal stamped on each child row. */
  const stamps: { providerParentRef?: string; attempt?: number }[] = []
  const evidenceLog: AgentChildWorkEvidence[][] = []
  const ingested: (AgentChildWorkReconcileOutcome | null)[] = []
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => clock,
    persistHandle: async () => {},
    onChildWorkEvidence: (sessionId, evidence) => {
      expect(sessionId).toBe('session-1')
      deliveries.push({ kind: 'evidence', detail: evidence.map((edge) => edge.type).join(',') })
      evidenceLog.push(evidence)
      if (host) {
        ingested.push(host.ingestStructuredChildWork(parent, evidence, 'claude'))
      } else {
        reconcileAgentChildWorkEvidence({ store, admission, parent, provider: 'claude', evidence })
      }
    }
  })
  const journal: StructuredAgentSessionEventSink = {
    appendItem: (identity, _body, options) => {
      deliveries.push({ kind: 'journal', detail: JSON.stringify(identity) })
      if (options?.agentId !== undefined) {
        stamps.push(options)
      }
    },
    appendTombstone: () => {},
    // Production's journal publication is what republishes the parent's own row.
    publish: () => deliveries.push({ kind: 'publish', detail: '' })
  }
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    events: journal
  })
  const send = (message: Record<string, unknown>): Delivery[] => {
    const from = deliveries.length
    claude.connections[0]!.handlers.onMessage?.(message)
    return deliveries.slice(from)
  }
  /** Captured frames, each at its captured time after `T0`. */
  const replay = (frames: readonly CapturedFrame[]) => {
    for (const { at, frame: captured } of frames) {
      clock = T0 + at
      send(frame(captured))
    }
  }
  const records = (): AgentChildWorkRecord[] =>
    host ? host.getStructuredChildWork(parent) : store.getChildren(parent)
  const byDescription = (description: string) =>
    records().find((record) => record.description === description)
  return {
    adapter,
    claude,
    store,
    send,
    replay,
    records,
    byDescription,
    evidenceLog,
    stamps,
    ingested
  }
}
