import { randomUUID } from 'node:crypto'
import { createAgentChildWorkAdmission } from '../../../shared/agent-status/child-work/agent-status-child-work-admission'
import { reconcileAgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-reconciliation'
import { createAgentStatusStore } from '../../../shared/agent-status/store/agent-status-store'
import { makeStructuredAgentStatusSubject } from '../../../shared/agent-status/contracts/agent-status-subject'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

function frame(fields: Record<string, unknown>) {
  return { session_id: PROVIDER_SESSION_ID, uuid: randomUUID(), ...fields }
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

export function toolResult(toolUseId: string, text: string) {
  return frame({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: false }]
    }
  })
}

export async function producer() {
  const claude = fakeClaude()
  const subject = (sessionId: string) =>
    makeStructuredAgentStatusSubject(
      {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'folder'
      },
      sessionId
    )
  const parent = subject('session-1')
  const store = createAgentStatusStore({ epoch: 'epoch-1', mode: 'authority' })
  store.applyMutation({ parent: { subject: parent } })
  let nextId = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: () => `child-${++nextId}`
  })
  const adapter = adapterFor(
    claude,
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    (sessionId, evidence) => {
      reconcileAgentChildWorkEvidence({
        store,
        admission,
        parent: subject(sessionId),
        provider: 'claude',
        evidence
      })
    }
  )
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    events: {
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  return {
    adapter,
    claude,
    send: (message: Record<string, unknown>) =>
      claude.connections[0]!.handlers.onMessage?.(message),
    records: () => store.getChildren(parent)
  }
}
