import type { AgentJournalItemBody } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach } from 'vitest'
import { codexProviderHandle } from '../../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { indexedStatusFeedSession } from '../../../../../native-chat/agent-session-wire/observations/testing/structured-agent-session-status-feed-test-session.test-fixture'
import { StructuredAgentSessionStatusFeed } from '../../../../../native-chat/agent-session-wire/observations/structured-agent-session-status-feed'
import { createStructuredAgentSessionLogger } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-logger'

export const STATUS_SESSION = 'session-status'
const journals = createTrackedJournalOpener()
let root: string
let feed: StructuredAgentSessionStatusFeed

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-rpc-status-'))
  const journal = await journals.open({
    stateDirectory: root,
    identity: {
      sessionId: STATUS_SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('native-status')
    }
  })
  const bodies: AgentJournalItemBody[] = [
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'write a poem' }] },
    { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } }
  ]
  for (const [ordinal, body] of bodies.entries()) {
    await journal.appendItem(
      { provider: 'codex', threadId: 'native-status', turnId: 'turn-1', ordinal },
      body,
      { fence: 0, turnScope: { kind: 'thread' } }
    )
  }
  feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([[STATUS_SESSION, indexedStatusFeedSession({ journal })]]),
    getConversation: () => null,
    now: () => 1_000
  })
  await feed.publish(STATUS_SESSION, journal, { replay: true })
})
afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

export const statusFeed = () => feed
