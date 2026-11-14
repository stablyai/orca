// Persist explicit queuedMessageId links; clients must not infer them by comparing unrelated IDs.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentSessionSendBodyFingerprint } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'

import type { AgentSessionJournal } from '../journal-store'
import { createTrackedJournalOpener } from '../store-lifecycle/journal-host-database-test-support'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

export function registerJournalSubmissionQueuedLinkTests(): void {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-q',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'claude',
    providerHandle: claudeProviderHandle('native-1', null)
  }
  const BODY: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'queued text' }]
  }
  const FINGERPRINT = agentSessionSendBodyFingerprint(IDENTITY.sessionId, BODY)

  let root: string
  let clock = 1_000
  const journals = createTrackedJournalOpener()

  function open(): Promise<AgentSessionJournal> {
    return journals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: () => ++clock,
      mintEpoch: () => `epoch-${clock}`
    })
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-queued-link-'))
    clock = 1_000
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  describe('the submission names the queued draft it hands off', () => {
    it('refuses a caller naming a different draft than the one it consumes, and writes nothing', async () => {
      const journal = await open()
      await journal.queuedMessages.insert({ messageId: 'draft-1', body: BODY })
      await expect(
        journal.appendSubmission(
          {
            clientMessageId: 'handoff-1',
            payloadFingerprint: FINGERPRINT,
            body: BODY,
            fence: 0,
            queuedMessageId: 'draft-2'
          },
          { messageId: 'draft-1', expect: 'waiting' }
        )
      ).rejects.toThrow()
      expect(journal.submissions()).toHaveLength(0)
      expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
    })
  })
}
