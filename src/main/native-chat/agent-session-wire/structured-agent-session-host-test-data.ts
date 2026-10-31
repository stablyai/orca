import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type {
  AgentJournalSnapshot,
  AgentJournalItemBody,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionRecord,
  AgentSessionExecutionLocation
} from '../../../shared/agent-session-record'
import { projectNativeChatTranscriptMessages } from '../../../shared/native-chat-transcript-projection'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import { structuredAgentSessionSendBody } from '../../../shared/structured-agent-session-send-mutation'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'

export const HOST_TEST_NOW = 1_800_000_000_000
export const HOST_TEST_SESSION = 'session-alpha'
export const HOST_TEST_THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'

export const HOST_TEST_LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}

let operations = 0

export function resetHostTestOperationIds(): void {
  operations = 0
}

export function hostTestOperationId(): string {
  operations += 1
  return `${HOST_TEST_NOW}-${operations.toString(16).padStart(32, '0')}`
}

export function hostTestMessage(text: string): ReturnType<typeof structuredAgentSessionSendBody> {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

export function hostTestAttachParams(
  expectedRuntimeFence: number | null,
  overrides: Partial<AgentSessionAttachParams> = {}
): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence,
      payloadFingerprint: '0'.repeat(64)
    },
    location: HOST_TEST_LOCATION,
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    providerHandle: { kind: 'codex', threadId: HOST_TEST_THREAD },
    ...overrides
  }
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: params.envelope.sessionId,
        fields: attachFingerprintFields(params)
      })
    }
  }
}

/** Render snapshot rows while sent composer items await journal acceptance. */
export function hostTestDrawnRowIds(
  snapshot: AgentJournalSnapshot,
  sent: readonly { clientMessageId: string; text: string }[]
): string[] {
  const optimistic = sent.map((message) => ({
    clientMessageId: message.clientMessageId,
    body: structuredAgentSessionSendBody(message.text, []),
    queuedAt: HOST_TEST_NOW
  }))
  return projectNativeChatTranscriptMessages(
    projectStructuredAgentSessionMessages(snapshot.items, optimistic, snapshot.submissions)
  ).map(({ id }) => id)
}

export function hostTestSendParams(text: string, clientOperationId = hostTestOperationId()) {
  const body = hostTestMessage(text)
  return {
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId,
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: HOST_TEST_SESSION,
        fields: { body }
      })
    },
    body
  }
}

export function hostTestCancelParams() {
  return {
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: HOST_TEST_SESSION,
        fields: { turnId: 'turn-none' }
      })
    },
    turnId: 'turn-none'
  }
}

export async function hostTestSubmission(
  host: Pick<StructuredAgentSessionHost, 'journalSnapshot'>,
  id: string
): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(HOST_TEST_SESSION)).submissions.find(
    (entry) => entry.clientMessageId === id
  )
}
export const CODEX_INPUT_FINALIZATION_ADMISSION_CASES = [
  ['queue-stop', 0],
  ['queue-close', 0],
  ['queue-quit', 0],
  ['pending-stop', 0],
  ['pending-close', 0],
  ['pending-close-cards', 0],
  ['pending-quit', 0],
  ['pending-exit', 0],
  ['queue-sleep', 0],
  ['pending-sleep', 0],
  ['pending-close-then-quit', 0],
  ['pending-quit-then-close', 0],
  ['pending-close-cards', 10],
  ['pending-close-cards', 100]
] as const

export const CODEX_INPUT_FINALIZATION_OWNER_OUTCOMES = [
  'null',
  'live',
  'admitted',
  'terminal',
  'normal',
  'fallback',
  'failed',
  'close-normal',
  'close-failed',
  'safe-close',
  'new-session',
  'new-live-child',
  'new-ended-child',
  'new-send'
] as const

export function hostTestRestingOptionsJournal(
  items: AgentJournalItemBody[] = [],
  wroteBeforeOpen = false
) {
  return {
    threadGoal: () => null,
    visitItems: (visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void) =>
      items.forEach((body, index) => visit(`item-${index}`, index + 1, body)),
    wroteBeforeOpen: () => wroteBeforeOpen,
    submissions: () => [],
    contextUsage: () => null,
    context: { floor: () => null }
  }
}

export function hostTestRestingOptionsRecord(sessionId = 'session-1'): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/homes/a' },
    providerHandleChain: [],
    location: { executionHostId: 'local', wslDistro: null },
    options: {}
  })
}

export function hostTestOptionsReadStore(record: () => AgentSessionRecord) {
  return {
    getRecord: record,
    getConversation: () => agentSessionConversationView(record()),
    requireWritableRecord: record
  }
}

export const HOST_TEST_RESTING_OPTIONS_CREATED_LINKS = [
  {
    origin: 'created',
    linkId: 'link-1',
    mintedAtFence: 1,
    observedAt: 1,
    handle: codexProviderHandle('provider-session-1')
  }
] satisfies AgentSessionRecord['providerHandleChain']

export function hostTestCatalogReadOperation() {
  const controller = new AbortController()
  return {
    retirement: 0,
    controller,
    signal: controller.signal,
    current: () => !controller.signal.aborted
  }
}
