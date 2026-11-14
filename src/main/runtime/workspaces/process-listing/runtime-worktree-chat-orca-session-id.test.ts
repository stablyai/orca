import { expect, it } from 'vitest'
import { collectRuntimeWorktreePtyAgentSources } from './runtime-worktree-pty-agent-sources'
import { createChatOrcaSessionIdResolver } from '../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import type { AgentSessionRecordReader } from '../../orchestration/addressing/session-lineage/structured-session-lineage'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'

const ROOT = 'codex_0b8f2a4e_6c1d_4f7a_9e3b_5a2c8d1f0e47'
const AFTER_CLEAR = 'codex_7d3e9b21_4a6c_4e8f_b2d5_1c9a7e3f6b08'

it('names a chat row by its conversation /clear root, the ID Copy Orca Session ID copies', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only each record's id and committed /clear.
  const store = {
    listRecords: () => [
      {
        sessionId: ROOT,
        conversationCommand: {
          command: 'clear',
          phase: 'committed',
          replacementSessionId: AFTER_CLEAR
        }
      }
    ]
  } as unknown as Pick<AgentSessionRecordReader, 'listRecords'>
  const tabId = structuredAgentSessionTabId(AFTER_CLEAR)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a chat's status row with the fields source collection reads.
  const chatRow = {
    paneKey: structuredAgentSessionPaneKey(tabId, AFTER_CLEAR),
    tabId,
    worktreeId: 'repo::/workspace',
    connectionId: null,
    structuredHost: 'owned',
    state: 'working',
    prompt: '',
    agentType: 'codex',
    receivedAt: 1,
    stateStartedAt: 1
  } as AgentStatusIpcPayload

  const [source] = collectRuntimeWorktreePtyAgentSources({
    hookSnapshots: [chatRow],
    mirroredWorktreeIdByTabId: new Map(),
    connectedPtyEvidence: {
      tabIds: new Set(),
      paneKeys: new Set(),
      ptyIdByTerminalHandle: new Map()
    },
    chatOrcaSessionId: createChatOrcaSessionIdResolver(store)
  })

  expect(source?.orcaSessionId).toBe(ROOT)
})
